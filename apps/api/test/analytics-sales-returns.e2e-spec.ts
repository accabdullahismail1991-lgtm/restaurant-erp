import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// The sales report used to show revenue with no hint that some of it later
// came back as a customer return -- a manager had to separately open the
// dedicated returns report and do the subtraction themselves. AnalyticsService
// .salesSummaryCore now folds in the same OrderReturn rows the returns report
// already reads (same location + period filter), so returnCount/returnsTotal/
// revenueAfterReturns sit right next to revenue in one response.
describe('Sales report includes returns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let ingredientId: string;
  let menuItemId: string;

  const PHONE = '+966500000240';
  const PASSWORD = 'SalesReturnsTest123';
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
    await prisma.role.deleteMany({ where: { name: 'SalesReturns-Test' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'pos.return_order', 'inventory.adjust', 'pos.manage_shift'] } } });

    const perms = await Promise.all(
      [
        { code: 'analytics.view', label: 'عرض التقارير' },
        { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' },
        { code: 'inventory.adjust', label: 'تسوية المخزون' },
        { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
      ].map((p) => prisma.permission.create({ data: p })),
    );
    const role = await prisma.role.create({ data: { name: 'SalesReturns-Test' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار مرتجعات المبيعات', type: 'BRANCH' } });
    locationId = location.id;
    const ingredient = await prisma.ingredient.create({
      data: { name: 'مكوّن اختبار مرتجعات المبيعات', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    ingredientId = ingredient.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار مرتجعات المبيعات', category: 'اختبار', price: 100 } });
    menuItemId = menuItem.id;
    await prisma.recipeLine.create({ data: { menuItemId, ingredientId, quantity: 1 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('sales-summary shows zero returns before any return is made', async () => {
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId, quantity: 10, unitCost: 1 });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    expect(payRes.status).toBe(200);

    const before = await request(app.getHttpServer()).get(`/analytics/sales-summary?locationId=${locationId}`).set(auth(token));
    expect(before.body.returnCount).toBe(0);
    expect(before.body.returnsTotal).toBe(0);
    expect(before.body.revenueAfterReturns).toBe(before.body.revenue);

    // Advance the line to READY (the kitchen-status guard added to
    // ReturnsService requires this before a return is allowed) then return it.
    const lineId = payRes.body.lines[0].id;
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(token));
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(token));
    const returnRes = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(token))
      .send({ orderId: payRes.body.id, reason: 'اختبار', lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect(returnRes.status).toBe(201);

    const after = await request(app.getHttpServer()).get(`/analytics/sales-summary?locationId=${locationId}`).set(auth(token));
    expect(after.body.returnCount).toBe(1);
    expect(after.body.returnsTotal).toBe(Number(returnRes.body.refundTotal));
    expect(after.body.revenueAfterReturns).toBe(round2(after.body.revenue - after.body.returnsTotal));

    function round2(n: number) {
      return Math.round(n * 100) / 100;
    }

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });
});
