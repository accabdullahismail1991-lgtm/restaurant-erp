import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase H: cashier accountability (who opened/closed a shift, who served
// an order, how it was paid) plus the two new analytics reports built on
// top of that (shifts-summary, payment-methods-summary) and the purchase
// side (purchase-returns-summary, covered lightly here since
// purchase-returns.e2e-spec.ts already exercises the create/inventory path).
describe('Phase H: cashier fields + new analytics reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewToken: string;
  let noPermToken: string;
  let locationId: string;
  let menuItemId: string;
  let userId: string;

  const VIEW_PHONE = '+966500000210';
  const NOPERM_PHONE = '+966500000211';
  const PASSWORD = 'PhaseHTest123';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [VIEW_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['PhaseH-Viewer', 'PhaseH-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: 'analytics.view' } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const role = await prisma.role.create({ data: { name: 'PhaseH-Viewer' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: viewPerm.id } });
    await prisma.role.create({ data: { name: 'PhaseH-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: 'كاشير ' + phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return { token: loginRes.body.accessToken as string, userId: user.id };
    };
    const viewUser = await makeUser(VIEW_PHONE, role.id);
    viewToken = viewUser.token;
    userId = viewUser.userId;
    noPermToken = (await makeUser(NOPERM_PHONE)).token;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار المرحلة H', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار المرحلة H', category: 'رئيسي', price: 40 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  let shiftId: string;
  let orderId: string;

  it('records openedBy on shift creation and exposes the cashier name via findAll/findOne', async () => {
    const openRes = await request(app.getHttpServer()).post('/shifts').set(auth(viewToken)).send({ locationId, openingFloat: 200 });
    expect(openRes.status).toBe(201);
    shiftId = openRes.body.id;

    const listRes = await request(app.getHttpServer()).get('/shifts').set(auth(viewToken)).query({ locationId });
    const shift = listRes.body.find((s: { id: string }) => s.id === shiftId);
    expect(shift.openedBy.id).toBe(userId);
    expect(shift.openedBy.name).toBe('كاشير ' + VIEW_PHONE);
    expect(shift.closedBy).toBeNull();
  });

  it('creates and pays an order, recording servedBy and the CARD payment method', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(viewToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    orderId = orderRes.body.id;

    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(viewToken))
      .send({ payments: [{ method: 'CARD', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal), terminalRef: 'TEST-TERM-1' }] });
    expect(payRes.status).toBe(200);

    const listRes = await request(app.getHttpServer()).get('/orders').set(auth(viewToken)).query({ locationId });
    const order = listRes.body.find((o: { id: string }) => o.id === orderId);
    expect(order.servedBy.id).toBe(userId);
    expect(order.payments).toEqual([{ method: 'CARD', amount: '46' }]); // 40 + 15% VAT
  });

  it('records closedById on shift close', async () => {
    const closeRes = await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(viewToken)).send({ closingCounted: 200 });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.closedBy.id).toBe(userId);
  });

  it('blocks the 3 new report endpoints without analytics.view (403)', async () => {
    const a = await request(app.getHttpServer()).get('/analytics/shifts-summary').set(auth(noPermToken)).query({ locationId });
    const b = await request(app.getHttpServer()).get('/analytics/payment-methods-summary').set(auth(noPermToken)).query({ locationId });
    const c = await request(app.getHttpServer()).get('/analytics/purchase-returns-summary').set(auth(noPermToken)).query({ locationId });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(c.status).toBe(403);
  });

  it('shifts-summary aggregates by cashier: shift count, sales, and it is closed', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/shifts-summary').set(auth(viewToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.shiftsCount).toBe(1);
    expect(res.body.openShiftsCount).toBe(0);
    expect(res.body.byCashier[0].cashierId).toBe(userId);
    expect(res.body.byCashier[0].totalSales).toBe(46);
  });

  it('payment-methods-summary breaks revenue down by method', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/payment-methods-summary').set(auth(viewToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.totalAmount).toBe(46);
    expect(res.body.byMethod).toEqual([{ method: 'CARD', count: 1, total: 46 }]);
  });

  it('purchase-returns-summary returns zeroed shape when nothing has been returned yet', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/purchase-returns-summary').set(auth(viewToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.returnCount).toBe(0);
    expect(res.body.totalAmount).toBe(0);
    expect(res.body.topReturnedIngredients).toEqual([]);
  });
});
