import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// OrderType replaces the old fixed OrderChannel enum (DINE_IN/TAKEAWAY/
// DRIVE_THRU/DELIVERY_PARTNER/BRAND_APP) with an admin-manageable table,
// same pattern as PaymentMethod: `code` is stable/immutable (stamped onto
// every Order.channel/Promotion.channelLimit row), name/icon/isActive are
// editable. OrdersService.create() and PromotionsService now validate
// channel/channelLimit against this table instead of a compile-time enum.
describe('Order types: admin-manageable order classification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let locationId: string;
  let shiftId: string;
  let menuItemId: string;

  const ADMIN_PHONE = '+966500000290';
  const NOPERM_PHONE = '+966500000291';
  const PASSWORD = 'OrderTypesTest123';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } } });
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.rolePermission.deleteMany({ where: { role: { name: { in: ['OrderTypes-Manager', 'OrderTypes-NoPerm'] } } } });
    await prisma.role.deleteMany({ where: { name: { in: ['OrderTypes-Manager', 'OrderTypes-NoPerm'] } } });

    const orderTypesPerm = await prisma.permission.upsert({
      where: { code: 'order_types.manage' },
      update: {},
      create: { code: 'order_types.manage', label: 'إدارة أنواع الطلبات' },
    });
    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const promotionsPerm = await prisma.permission.upsert({
      where: { code: 'promotions.manage' },
      update: {},
      create: { code: 'promotions.manage', label: 'إدارة العروض والخصومات' },
    });
    const role = await prisma.role.create({ data: { name: 'OrderTypes-Manager' } });
    await prisma.rolePermission.createMany({
      data: [orderTypesPerm, shiftPerm, promotionsPerm].map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    await prisma.role.create({ data: { name: 'OrderTypes-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار أنواع الطلبات', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار أنواع الطلبات', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the seeded 5 pre-existing order types for any logged-in user (no permission needed)', async () => {
    const res = await request(app.getHttpServer()).get('/order-types').set(auth(noPermToken));
    expect(res.status).toBe(200);
    const codes = res.body.map((t: { code: string }) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['DINE_IN', 'TAKEAWAY', 'DRIVE_THRU', 'DELIVERY_PARTNER', 'BRAND_APP']));
    const dineIn = res.body.find((t: { code: string }) => t.code === 'DINE_IN');
    expect(dineIn.name).toBe('صالة');
    expect(dineIn.isActive).toBe(true);
  });

  it('blocks creating/updating order types without order_types.manage (403)', async () => {
    const res = await request(app.getHttpServer()).post('/order-types').set(auth(noPermToken)).send({ name: 'نافذة السيارة', code: 'CURBSIDE' });
    expect(res.status).toBe(403);
  });

  it('creates a new order type and rejects a duplicate code', async () => {
    const res = await request(app.getHttpServer())
      .post('/order-types')
      .set(auth(adminToken))
      .send({ name: 'استلام من السيارة', code: 'CURBSIDE', icon: '🚙' });
    expect(res.status).toBe(201);
    expect(res.body.isActive).toBe(true);

    const dup = await request(app.getHttpServer())
      .post('/order-types')
      .set(auth(adminToken))
      .send({ name: 'اسم آخر', code: 'CURBSIDE' });
    expect(dup.status).toBe(409);
  });

  it('an order can be created with a freshly admin-added order type code', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'CURBSIDE', lines: [{ menuItemId, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('CURBSIDE');
  });

  it('rejects an order with an unknown channel code (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'NOT_A_REAL_TYPE', lines: [{ menuItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('deactivating an order type via PATCH is reflected, code cannot be changed, and orders stop accepting it', async () => {
    const created = await request(app.getHttpServer())
      .post('/order-types')
      .set(auth(adminToken))
      .send({ name: 'قناة تُلغى', code: 'RETIRED_CHANNEL' });
    const patched = await request(app.getHttpServer())
      .patch(`/order-types/${created.body.id}`)
      .set(auth(adminToken))
      .send({ isActive: false, name: 'قناة مُلغاة' });
    expect(patched.status).toBe(200);
    expect(patched.body.isActive).toBe(false);
    expect(patched.body.name).toBe('قناة مُلغاة');
    expect(patched.body.code).toBe('RETIRED_CHANNEL');

    const activeOnly = await request(app.getHttpServer()).get('/order-types').query({ activeOnly: 'true' }).set(auth(noPermToken));
    expect(activeOnly.body.find((t: { code: string }) => t.code === 'RETIRED_CHANNEL')).toBeUndefined();

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'RETIRED_CHANNEL', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(400);
  });

  it('rejects a promotion with an unknown channelLimit code, accepts a real one', async () => {
    const bad = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'عرض خاطئ', type: 'PERCENTAGE_DISCOUNT', value: 10, channelLimit: 'NOT_A_REAL_TYPE' });
    expect(bad.status).toBe(400);

    const good = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(adminToken))
      .send({ name: 'عرض صالة فقط', type: 'PERCENTAGE_DISCOUNT', value: 10, channelLimit: 'DINE_IN' });
    expect(good.status).toBe(201);
    expect(good.body.channelLimit).toBe('DINE_IN');
  });
});
