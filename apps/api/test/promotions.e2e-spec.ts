import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 10b: Promotions -- a calculation layer separate from base pricing
// (docs/DECISIONS.md #14). Only PERCENTAGE_DISCOUNT/FIXED_DISCOUNT are
// ever auto-applied; BOGO/COMBO are rejected at creation time rather than
// silently accepted and never actually discounting anything. Runs against
// a real app + a real Postgres test database, same as every other suite.
describe('Phase 10b: promotions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let locationId: string;
  let menuItemId: string;
  let shiftId: string;

  const ADMIN_PHONE = '+966500000090';
  const NOPERM_PHONE = '+966500000091';
  const PASSWORD = 'PromoTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'Promo-Test-' } } });
    await prisma.permission.deleteMany({ where: { code: 'promotions.manage' } });

    const perm = await prisma.permission.create({ data: { code: 'promotions.manage', label: 'إدارة العروض' } });
    const adminRole = await prisma.role.create({ data: { name: 'Promo-Test-Admin' } });
    await prisma.rolePermission.create({ data: { roleId: adminRole.id, permissionId: perm.id } });
    await prisma.role.create({ data: { name: 'Promo-Test-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, adminRole.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار العروض', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار العروض', category: 'رئيسي', price: 100 } });
    menuItemId = menuItem.id;

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks a user without promotions.manage from creating a promotion (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(noPermToken))
      .send({ name: 'خصم تجريبي', type: 'PERCENTAGE_DISCOUNT', value: 10 });
    expect(res.status).toBe(403);
  });

  it('rejects creating a BOGO or COMBO promotion -- not silently accepted, since the engine can never apply them', async () => {
    const res = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'اشترِ واحصل على واحد', type: 'BOGO', value: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects a percentage discount over 100%', async () => {
    const res = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم غير منطقي', type: 'PERCENTAGE_DISCOUNT', value: 150 });
    expect(res.status).toBe(400);
  });

  it('auto-applies the only active promotion to a fresh order (no manual discountTotal given)', async () => {
    const promoRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم 10% لكل القنوات', type: 'PERCENTAGE_DISCOUNT', value: 10 });
    expect(promoRes.status).toBe(201);
    const promotionId = promoRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.promotionId).toBe(promotionId);
    expect(Number(orderRes.body.discountTotal)).toBe(10); // 10% of 100
    expect(Number(orderRes.body.subtotal)).toBe(100);
    expect(Number(orderRes.body.vatTotal)).toBeCloseTo((100 - 10) * 0.15, 2);
    expect(Number(orderRes.body.grandTotal)).toBeCloseTo(90 + (100 - 10) * 0.15, 2);

    // Deactivate so it doesn't leak into the other tests below.
    await request(app.getHttpServer()).patch(`/promotions/${promotionId}`).set(auth(adminToken)).send({ isActive: false });
  });

  it('a manual discountTotal from the cashier overrides auto-promotion entirely', async () => {
    const promoRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم 20% لكل القنوات', type: 'PERCENTAGE_DISCOUNT', value: 20 });
    const promotionId = promoRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', discountTotal: 5, lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.promotionId).toBeNull();
    expect(Number(orderRes.body.discountTotal)).toBe(5);

    await request(app.getHttpServer()).patch(`/promotions/${promotionId}`).set(auth(adminToken)).send({ isActive: false });
  });

  it('never applies a promotion limited to a different channel', async () => {
    const promoRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم توصيل فقط', type: 'PERCENTAGE_DISCOUNT', value: 15, channelLimit: 'DELIVERY_PARTNER' });
    const promotionId = promoRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.body.promotionId).toBeNull();
    expect(Number(orderRes.body.discountTotal)).toBe(0);

    await request(app.getHttpServer()).patch(`/promotions/${promotionId}`).set(auth(adminToken)).send({ isActive: false });
  });

  it('ignores a promotion that has not started yet or has already ended', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const notStartedRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'عرض قادم', type: 'FIXED_DISCOUNT', value: 50, startsAt: future });
    const endedRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'عرض منتهٍ', type: 'FIXED_DISCOUNT', value: 50, endsAt: past });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.body.promotionId).toBeNull();
    expect(Number(orderRes.body.discountTotal)).toBe(0);

    await request(app.getHttpServer()).patch(`/promotions/${notStartedRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
    await request(app.getHttpServer()).patch(`/promotions/${endedRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
  });

  it('tie-break: a channel-specific promotion beats a channel-agnostic one even if it discounts less', async () => {
    const generalRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم عام كبير', type: 'PERCENTAGE_DISCOUNT', value: 50 });
    const specificRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم صالة صغير', type: 'PERCENTAGE_DISCOUNT', value: 5, channelLimit: 'DINE_IN' });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.body.promotionId).toBe(specificRes.body.id);
    expect(Number(orderRes.body.discountTotal)).toBe(5); // the smaller, but more specific, discount wins

    await request(app.getHttpServer()).patch(`/promotions/${generalRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
    await request(app.getHttpServer()).patch(`/promotions/${specificRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
  });

  it('among equally specific candidates, picks the one with the bigger discount', async () => {
    const smallRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم عام صغير', type: 'FIXED_DISCOUNT', value: 3 });
    const bigRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم عام أكبر', type: 'FIXED_DISCOUNT', value: 8 });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.body.promotionId).toBe(bigRes.body.id);
    expect(Number(orderRes.body.discountTotal)).toBe(8);

    await request(app.getHttpServer()).patch(`/promotions/${smallRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
    await request(app.getHttpServer()).patch(`/promotions/${bigRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
  });

  it('a fixed discount is capped at the subtotal, never producing a negative discountTotal margin', async () => {
    const promoRes = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'خصم أكبر من الفاتورة', type: 'FIXED_DISCOUNT', value: 9999 });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(Number(orderRes.body.discountTotal)).toBe(100); // capped at subtotal, not 9999
    expect(Number(orderRes.body.grandTotal)).toBe(0);

    await request(app.getHttpServer()).patch(`/promotions/${promoRes.body.id}`).set(auth(adminToken)).send({ isActive: false });
  });
});
