import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A dedicated Net Sales report: gross sales, discount, net-of-discount
// EXCLUDING vs INCLUDING VAT side by side, distinct customer count (not
// just order count), and average invoice both ways -- the standard
// financial-review shape a manager expects rather than reading it off the
// general sales-summary. Engineers two orders with a known price/discount/VAT
// so every figure can be verified exactly, one tied to a customer and one
// walk-in, to check customerCount counts customers, not orders.
describe('Net Sales report (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let menuItemId: string;
  let customerId: string;

  const PHONE = '+966500000250';
  const PASSWORD = 'NetSalesTest123';
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
    await prisma.role.deleteMany({ where: { name: 'NetSales-Test' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'pos.apply_discount', 'pos.manage_shift'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const discountPerm = await prisma.permission.create({ data: { code: 'pos.apply_discount', label: 'تطبيق خصم يدوي' } });
    const shiftPerm = await prisma.permission.create({ data: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' } });
    const role = await prisma.role.create({ data: { name: 'NetSales-Test' } });
    await prisma.rolePermission.createMany({ data: [viewPerm, discountPerm, shiftPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار صافي المبيعات', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار صافي المبيعات', category: 'اختبار', price: 100 } });
    menuItemId = menuItem.id;
    const customer = await prisma.customer.create({ data: { name: 'عميل اختبار صافي المبيعات', phone: '+966599990010' } });
    customerId = customer.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('computes gross/discount/net-excl-VAT/VAT/net-incl-VAT exactly, and counts distinct customers', async () => {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    // Order 1: tied to a customer, 100 subtotal, no discount -> 100 + 15 VAT = 115.
    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', customerId, lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order1.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order1.body.grandTotal) }] });

    // Order 2: walk-in (no customerId), 200 subtotal, 20 discount -> net excl
    // VAT 180, VAT 15% of 180 = 27, total 207.
    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'TAKEAWAY', discountTotal: 20, lines: [{ menuItemId, quantity: 2 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order2.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order2.body.grandTotal) }] });

    const res = await request(app.getHttpServer()).get(`/analytics/net-sales?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(2);
    expect(res.body.customerCount).toBe(1);
    expect(res.body.walkInOrderCount).toBe(1);
    expect(res.body.grossSales).toBe(300); // 100 + 200
    expect(res.body.discountGiven).toBe(20);
    expect(res.body.netSalesExclVat).toBe(280); // 300 - 20
    expect(res.body.vatTotal).toBe(15 + 27);
    expect(res.body.netSalesInclVat).toBe(115 + 207);
    expect(res.body.averageInvoiceExclVat).toBe(140); // 280 / 2
    expect(res.body.averageInvoiceInclVat).toBe(161); // 322 / 2
    expect(res.body.byDay).toHaveLength(1);
    expect(res.body.byDay[0].orderCount).toBe(2);
    expect(res.body.byDay[0].netSalesInclVat).toBe(322);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it('blocks without analytics.view (403)', async () => {
    const NOPERM_PHONE = '+966500000251';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const res = await request(app.getHttpServer()).get(`/analytics/net-sales?locationId=${locationId}`).set(auth(loginRes.body.accessToken));
    expect(res.status).toBe(403);
  });
});
