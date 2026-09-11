import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Three related additions, all requested together: (1) explicitly parking
// an unpaid order (OrdersService.hold()) leaves an OrderActivityLog trail
// instead of silently doing nothing; (2) ShiftsService.close() now refuses
// to close while any order tied to the shift isn't PAID/VOIDED yet; (3)
// Location.vatRate replaces the old hardcoded 15% constant, and
// Location.allowNegativeStock lets a branch opt into overselling instead
// of InventoryService.consume() always rejecting insufficient stock.
describe('Hold/park orders, shift-close guard, configurable VAT + negative stock (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let menuItemId: string;

  const ADMIN_PHONE = '+966500000230';
  const PASSWORD = 'HoldShiftVatTest123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار التعليق والضريبة', category: 'رئيسي', price: 100 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('holding an order logs a HELD activity entry and leaves it unpaid', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار التعليق', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);

    const holdRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/hold`)
      .set(auth(adminToken))
      .send({ note: 'العميل غادر للسيارة لإحضار المحفظة' });
    expect(holdRes.status).toBe(200);
    expect(holdRes.body.status).not.toBe('PAID');
    expect(holdRes.body.activityLog).toHaveLength(1);
    expect(holdRes.body.activityLog[0].action).toBe('HELD');
    expect(holdRes.body.activityLog[0].note).toContain('المحفظة');

    // close out this throwaway shift's order so it doesn't dangle
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
  });

  it('rejects holding an already-PAID order (400)', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار تعليق مدفوع', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    const holdRes = await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/hold`).set(auth(adminToken)).send({});
    expect(holdRes.status).toBe(400);
  });

  it('blocks closing a shift while an order on it is unpaid/held, then succeeds once it is paid', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار قفل الوردية', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/hold`).set(auth(adminToken)).send({});

    const blockedClose = await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(adminToken)).send({ closingCounted: 100 });
    expect(blockedClose.status).toBe(400);
    expect(blockedClose.body.message).toContain('1');

    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    const closeRes = await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(adminToken)).send({ closingCounted: 100 + Number(orderRes.body.grandTotal) });
    expect(closeRes.status).toBe(200);
  });

  it("a location's custom vatRate drives order VAT math instead of a fixed 15%", async () => {
    const location = await prisma.location.create({ data: { name: 'فرع بضريبة 10%', type: 'BRANCH', vatRate: 10 } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(Number(orderRes.body.vatTotal)).toBe(10); // 100 * 10%
    expect(Number(orderRes.body.grandTotal)).toBe(110);
  });

  it('rejects an order when stock is insufficient and allowNegativeStock is off (default)', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع بلا بيع بالسالب', type: 'BRANCH' } });
    const ingredient = await prisma.ingredient.create({ data: { name: 'خامة اختبار سالب مرفوض', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 5 } });
    const item = await prisma.menuItem.create({ data: { name: 'صنف بلا بيع بالسالب', category: 'رئيسي', price: 10 } });
    await prisma.recipeLine.create({ data: { menuItemId: item.id, ingredientId: ingredient.id, quantity: 1 } });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 1 }] });
    expect(orderRes.status).toBe(400);
  });

  it('allows selling past zero stock when allowNegativeStock is on, and the balance goes negative', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع بيع بالسالب مفعّل', type: 'BRANCH', allowNegativeStock: true } });
    const ingredient = await prisma.ingredient.create({ data: { name: 'خامة اختبار سالب مسموح', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 5 } });
    const item = await prisma.menuItem.create({ data: { name: 'صنف بيع بالسالب مفعّل', category: 'رئيسي', price: 10 } });
    await prisma.recipeLine.create({ data: { menuItemId: item.id, ingredientId: ingredient.id, quantity: 3 } });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 1 }] });
    expect(orderRes.status).toBe(201);

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${location.id}`).set(auth(adminToken));
    const balance = balances.body.find((b: any) => b.ingredientId === ingredient.id);
    expect(Number(balance.quantity)).toBe(-3);
  });
});
