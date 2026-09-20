import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Extends 6 previously location/date-only analytics reports (top-items,
// top-customers, tax-summary, peak-hours, customer-experience, kitchen-
// performance) with the same channel/paymentMethod/customerId filters
// salesSummary/salesLog/netSales already had -- mirrors that exact
// service-layer pattern (Order.channel, Order.customerId, Order.payments
// some-method), just applied to a few more reports whose admin-panel
// screens were silently ignoring those params before this change (topItems
// in particular was already being SENT a channel filter by the Sales
// Report screen's shared qs, but the backend used to drop it on the floor).
describe('Order-based analytics filters: channel / paymentMethod / customerId (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let menuItemId: string;
  let customerAId: string;
  let customerBId: string;

  const PHONE = '+966500000320';
  const PASSWORD = 'OrderFilterTest123';
  const auth = (t: string = token) => ({ Authorization: `Bearer ${t}` });

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
    await prisma.role.deleteMany({ where: { name: 'OrderFilter-Test' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'pos.manage_shift'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const shiftPerm = await prisma.permission.create({ data: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' } });
    const role = await prisma.role.create({ data: { name: 'OrderFilter-Test' } });
    await prisma.rolePermission.createMany({ data: [viewPerm, shiftPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار فلاتر التقارير', category: 'اختبار', price: 100 } });
    menuItemId = menuItem.id;
    const customerA = await prisma.customer.create({ data: { name: 'عميل أ فلاتر التقارير', phone: '+966599990030' } });
    customerAId = customerA.id;
    const customerB = await prisma.customer.create({ data: { name: 'عميل ب فلاتر التقارير', phone: '+966599990031' } });
    customerBId = customerB.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // order1: DINE_IN / customer A / CASH / qty 2. order2: TAKEAWAY / customer
  // B / CARD / qty 3 -- every assertion below narrows one of the three new
  // filters to isolate exactly one of these two orders.
  async function makeTwoDistinctOrders(locationId: string, shiftId: string) {
    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth())
      .send({ locationId, shiftId, channel: 'DINE_IN', customerId: customerAId, lines: [{ menuItemId, quantity: 2 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order1.body.id}/pay`)
      .set(auth())
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order1.body.grandTotal) }] });

    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth())
      .send({ locationId, shiftId, channel: 'TAKEAWAY', customerId: customerBId, lines: [{ menuItemId, quantity: 3 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order2.body.id}/pay`)
      .set(auth())
      .send({ payments: [{ method: 'CARD', mode: 'MANUAL', amount: Number(order2.body.grandTotal) }] });

    return { order1: order1.body, order2: order2.body };
  }

  it('top-items respects channel, paymentMethod, and customerId', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار فلاتر 1', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth()).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    await makeTwoDistinctOrders(location.id, shiftId);

    const unfiltered = await request(app.getHttpServer()).get(`/analytics/top-items?locationId=${location.id}`).set(auth());
    expect(unfiltered.body[0].quantity).toBe(5);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/top-items?locationId=${location.id}&channel=DINE_IN`).set(auth());
    expect(byChannel.body[0].quantity).toBe(2);

    const byPayment = await request(app.getHttpServer()).get(`/analytics/top-items?locationId=${location.id}&paymentMethod=CARD`).set(auth());
    expect(byPayment.body[0].quantity).toBe(3);

    const byCustomer = await request(app.getHttpServer()).get(`/analytics/top-items?locationId=${location.id}&customerId=${customerAId}`).set(auth());
    expect(byCustomer.body[0].quantity).toBe(2);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth()).send({ closingCounted: 100 });
  });

  it('top-customers respects channel and paymentMethod', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار فلاتر 2', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth()).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    await makeTwoDistinctOrders(location.id, shiftId);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/top-customers?locationId=${location.id}&channel=DINE_IN`).set(auth());
    expect(byChannel.body).toHaveLength(1);
    expect(byChannel.body[0].customerId).toBe(customerAId);

    const byPayment = await request(app.getHttpServer()).get(`/analytics/top-customers?locationId=${location.id}&paymentMethod=CARD`).set(auth());
    expect(byPayment.body).toHaveLength(1);
    expect(byPayment.body[0].customerId).toBe(customerBId);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth()).send({ closingCounted: 100 });
  });

  it('tax-summary respects channel, paymentMethod, and customerId', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار فلاتر 3', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth()).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    await makeTwoDistinctOrders(location.id, shiftId);

    // order1 grandTotal = 2*100*1.15 = 230 -> vat 30. order2 = 3*100*1.15 = 345 -> vat 45.
    const unfiltered = await request(app.getHttpServer()).get(`/analytics/tax-summary?locationId=${location.id}`).set(auth());
    expect(unfiltered.body.sales.vatCollected).toBe(75);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/tax-summary?locationId=${location.id}&channel=DINE_IN`).set(auth());
    expect(byChannel.body.sales.vatCollected).toBe(30);

    const byPayment = await request(app.getHttpServer()).get(`/analytics/tax-summary?locationId=${location.id}&paymentMethod=CARD`).set(auth());
    expect(byPayment.body.sales.vatCollected).toBe(45);

    const byCustomer = await request(app.getHttpServer()).get(`/analytics/tax-summary?locationId=${location.id}&customerId=${customerAId}`).set(auth());
    expect(byCustomer.body.sales.vatCollected).toBe(30);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth()).send({ closingCounted: 100 });
  });

  it('peak-hours respects channel, paymentMethod, and customerId', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار فلاتر 4', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth()).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    await makeTwoDistinctOrders(location.id, shiftId);

    const unfiltered = await request(app.getHttpServer()).get(`/analytics/peak-hours?locationId=${location.id}`).set(auth());
    const totalUnfiltered = unfiltered.body.byHour.reduce((s: number, h: any) => s + h.orderCount, 0);
    expect(totalUnfiltered).toBe(2);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/peak-hours?locationId=${location.id}&channel=DINE_IN`).set(auth());
    const totalByChannel = byChannel.body.byHour.reduce((s: number, h: any) => s + h.orderCount, 0);
    expect(totalByChannel).toBe(1);

    const byCustomer = await request(app.getHttpServer()).get(`/analytics/peak-hours?locationId=${location.id}&customerId=${customerBId}`).set(auth());
    const totalByCustomer = byCustomer.body.byHour.reduce((s: number, h: any) => s + h.orderCount, 0);
    expect(totalByCustomer).toBe(1);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth()).send({ closingCounted: 100 });
  });

  it('customer-experience respects channel and paymentMethod', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار فلاتر 5', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth()).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    await makeTwoDistinctOrders(location.id, shiftId);

    const unfiltered = await request(app.getHttpServer()).get(`/analytics/customer-experience?locationId=${location.id}`).set(auth());
    expect(unfiltered.body.totalOrders).toBe(2);
    expect(unfiltered.body.distinctCustomersIdentified).toBe(2);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/customer-experience?locationId=${location.id}&channel=DINE_IN`).set(auth());
    expect(byChannel.body.totalOrders).toBe(1);
    expect(byChannel.body.distinctCustomersIdentified).toBe(1);

    const byPayment = await request(app.getHttpServer()).get(`/analytics/customer-experience?locationId=${location.id}&paymentMethod=CARD`).set(auth());
    expect(byPayment.body.totalOrders).toBe(1);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth()).send({ closingCounted: 100 });
  });

  it('kitchen-performance respects channel, paymentMethod, and customerId', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار فلاتر 6', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth()).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth())
      .send({ locationId: location.id, shiftId, channel: 'DINE_IN', customerId: customerAId, lines: [{ menuItemId, quantity: 1 }] });
    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth())
      .send({ locationId: location.id, shiftId, channel: 'TAKEAWAY', customerId: customerBId, lines: [{ menuItemId, quantity: 1 }] });

    // Advance each order's single line QUEUED -> PREPARING -> READY so it's
    // picked up by kitchenPerformanceCore's `readyAt: { not: null }` filter.
    const line1Id = order1.body.lines[0].id;
    const line2Id = order2.body.lines[0].id;
    await request(app.getHttpServer()).post(`/kitchen/lines/${line1Id}/advance`).set(auth());
    await request(app.getHttpServer()).post(`/kitchen/lines/${line1Id}/advance`).set(auth());
    await request(app.getHttpServer()).post(`/kitchen/lines/${line2Id}/advance`).set(auth());
    await request(app.getHttpServer()).post(`/kitchen/lines/${line2Id}/advance`).set(auth());

    await request(app.getHttpServer()).post(`/orders/${order1.body.id}/pay`).set(auth()).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order1.body.grandTotal) }] });
    await request(app.getHttpServer()).post(`/orders/${order2.body.id}/pay`).set(auth()).send({ payments: [{ method: 'CARD', mode: 'MANUAL', amount: Number(order2.body.grandTotal) }] });

    const unfiltered = await request(app.getHttpServer()).get(`/analytics/kitchen-performance?locationId=${location.id}`).set(auth());
    expect(unfiltered.body.linesReady).toBe(2);

    const byChannel = await request(app.getHttpServer()).get(`/analytics/kitchen-performance?locationId=${location.id}&channel=DINE_IN`).set(auth());
    expect(byChannel.body.linesReady).toBe(1);

    const byPayment = await request(app.getHttpServer()).get(`/analytics/kitchen-performance?locationId=${location.id}&paymentMethod=CARD`).set(auth());
    expect(byPayment.body.linesReady).toBe(1);

    const byCustomer = await request(app.getHttpServer()).get(`/analytics/kitchen-performance?locationId=${location.id}&customerId=${customerAId}`).set(auth());
    expect(byCustomer.body.linesReady).toBe(1);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth()).send({ closingCounted: 100 });
  });
});
