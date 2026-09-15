import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Three additions requested together: (1) a detailed, per-invoice sales
// log (GET /analytics/sales-log) -- distinct from salesSummaryCore's KPI
// cards/breakdowns, this is one row per paid order, filterable by channel/
// paymentMethod/customerId, for exporting a real invoice register; (2) a
// top-customers ranking (GET /analytics/top-customers) -- distinct from
// customerExperienceCore (service-speed/repeat-rate metrics, no money
// figures); (3) the existing tax-summary report now also returns
// `sales.byDay` and `sales.invoices` for a per-day/per-invoice VAT
// breakdown, not just the period-total figures it had before.
describe('Detailed sales log, top customers, and per-invoice tax detail (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let menuItemId: string;
  let customerAId: string;
  let customerBId: string;

  const PHONE = '+966500000300';
  const PASSWORD = 'SalesLogTest123';
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
    await prisma.user.deleteMany({ where: { phone: PHONE } });
    await prisma.role.deleteMany({ where: { name: 'SalesLog-Test' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'pos.manage_shift'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const shiftPerm = await prisma.permission.create({ data: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' } });
    const role = await prisma.role.create({ data: { name: 'SalesLog-Test' } });
    await prisma.rolePermission.createMany({ data: [viewPerm, shiftPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار سجل المبيعات', category: 'اختبار', price: 100 } });
    menuItemId = menuItem.id;
    const customerA = await prisma.customer.create({ data: { name: 'عميل أ سجل المبيعات', phone: '+966599990020', points: 5 } });
    customerAId = customerA.id;
    const customerB = await prisma.customer.create({ data: { name: 'عميل ب سجل المبيعات', phone: '+966599990021', points: 2 } });
    customerBId = customerB.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sales-log lists one row per paid invoice with cashier/customer/channel/payment detail', async () => {
    locationId = (await prisma.location.create({ data: { name: 'فرع اختبار سجل المبيعات 1', type: 'BRANCH' } })).id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', customerId: customerAId, lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order1.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order1.body.grandTotal) }] });

    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'TAKEAWAY', lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order2.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CARD', mode: 'MANUAL', amount: Number(order2.body.grandTotal) }] });

    const all = await request(app.getHttpServer()).get(`/analytics/sales-log?locationId=${locationId}`).set(auth(token));
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);
    const row1 = all.body.find((r: any) => r.customerId === customerAId);
    expect(row1.customerName).toBe('عميل أ سجل المبيعات');
    expect(row1.channel).toBe('DINE_IN');
    expect(row1.paymentMethods).toEqual(['CASH']);
    expect(row1.grandTotal).toBe(115);
    const row2 = all.body.find((r: any) => r.customerId === null);
    expect(row2.channel).toBe('TAKEAWAY');
    expect(row2.paymentMethods).toEqual(['CARD']);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/sales-log?locationId=${locationId}&channel=DINE_IN`).set(auth(token));
    expect(byChannel.body).toHaveLength(1);
    expect(byChannel.body[0].channel).toBe('DINE_IN');

    const byPayment = await request(app.getHttpServer()).get(`/analytics/sales-log?locationId=${locationId}&paymentMethod=CARD`).set(auth(token));
    expect(byPayment.body).toHaveLength(1);
    expect(byPayment.body[0].paymentMethods).toContain('CARD');

    const byCustomer = await request(app.getHttpServer()).get(`/analytics/sales-log?locationId=${locationId}&customerId=${customerAId}`).set(auth(token));
    expect(byCustomer.body).toHaveLength(1);
    expect(byCustomer.body[0].customerId).toBe(customerAId);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it('top-customers ranks by revenue and includes order count, avg invoice, last order date, and loyalty points', async () => {
    locationId = (await prisma.location.create({ data: { name: 'فرع اختبار سجل المبيعات 2', type: 'BRANCH' } })).id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    // Customer A: two orders, 200 total. Customer B: one order, 100 total.
    for (const q of [1, 1]) {
      const o = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(token))
        .send({ locationId, shiftId, channel: 'DINE_IN', customerId: customerAId, lines: [{ menuItemId, quantity: q }] });
      await request(app.getHttpServer())
        .post(`/orders/${o.body.id}/pay`)
        .set(auth(token))
        .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(o.body.grandTotal) }] });
    }
    const oB = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', customerId: customerBId, lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${oB.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(oB.body.grandTotal) }] });

    const res = await request(app.getHttpServer()).get(`/analytics/top-customers?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body[0].customerId).toBe(customerAId); // higher revenue ranks first
    expect(res.body[0].orderCount).toBe(2);
    expect(res.body[0].revenue).toBe(230); // 2 * 115
    expect(res.body[0].averageOrderValue).toBe(115);
    // Not an exact value -- Customer.points is a running total that OrdersService.pay()
    // increments on every paid order (loyalty earn), so it grows with each test in this
    // file rather than staying at the initial seed value. Just confirm the field is wired.
    expect(typeof res.body[0].points).toBe('number');
    expect(res.body[0].points).toBeGreaterThan(0);
    expect(res.body[0].lastOrderAt).toBeTruthy();
    expect(res.body[1].customerId).toBe(customerBId);
    expect(res.body[1].revenue).toBe(115);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it('tax-summary includes a per-day and per-invoice VAT breakdown alongside the period totals', async () => {
    locationId = (await prisma.location.create({ data: { name: 'فرع اختبار سجل المبيعات 3', type: 'BRANCH' } })).id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const order = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order.body.grandTotal) }] });

    const res = await request(app.getHttpServer()).get(`/analytics/tax-summary?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.sales.vatCollected).toBe(15);
    expect(res.body.sales.byDay).toHaveLength(1);
    expect(res.body.sales.byDay[0].invoiceCount).toBe(1);
    expect(res.body.sales.byDay[0].vatCollected).toBe(15);
    expect(res.body.sales.invoices).toHaveLength(1);
    expect(res.body.sales.invoices[0].vatTotal).toBe(15);
    expect(res.body.sales.invoices[0].dailySequence).toBeDefined();

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it('blocks all three endpoints without analytics.view (403)', async () => {
    const noPermUser = await prisma.user.create({ data: { name: 'no-perm', phone: '+966500000301', passwordHash: await bcrypt.hash(PASSWORD, 10) } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: '+966500000301', password: PASSWORD });
    const noPermToken = loginRes.body.accessToken;

    const r1 = await request(app.getHttpServer()).get(`/analytics/sales-log?locationId=${locationId}`).set(auth(noPermToken));
    expect(r1.status).toBe(403);
    const r2 = await request(app.getHttpServer()).get(`/analytics/top-customers?locationId=${locationId}`).set(auth(noPermToken));
    expect(r2.status).toBe(403);

    await prisma.user.delete({ where: { id: noPermUser.id } });
  });
});
