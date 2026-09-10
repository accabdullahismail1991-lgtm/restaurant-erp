import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase F: two new analytics reports (purchasing spend, returns/refunds)
// backing the per-module report sub-tabs in the admin panel -- gated
// behind analytics.view same as every other commercially-sensitive number
// here. Rows are seeded directly via Prisma (not the full PO/return
// workflow, already covered by purchasing.e2e-spec.ts/returns.e2e-spec.ts)
// since this only needs to verify the AGGREGATION, not the workflow.
describe('Analytics: purchasing + returns summaries (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewToken: string;
  let noPermToken: string;
  let locationId: string;
  let userId: string;

  const VIEW_PHONE = '+966500000180';
  const NOPERM_PHONE = '+966500000181';
  const PASSWORD = 'ReportsTest123';

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
    await prisma.role.deleteMany({ where: { name: { in: ['Reports-Test-Viewer', 'Reports-Test-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: 'analytics.view' } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const role = await prisma.role.create({ data: { name: 'Reports-Test-Viewer' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: viewPerm.id } });
    await prisma.role.create({ data: { name: 'Reports-Test-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return { token: loginRes.body.accessToken as string, userId: user.id };
    };
    const viewUser = await makeUser(VIEW_PHONE, role.id);
    viewToken = viewUser.token;
    userId = viewUser.userId;
    noPermToken = (await makeUser(NOPERM_PHONE)).token;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار تقارير المشتريات والمرتجعات', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks purchasing-summary and returns-summary without analytics.view (403)', async () => {
    const a = await request(app.getHttpServer()).get('/analytics/purchasing-summary').set(auth(noPermToken)).query({ locationId });
    const b = await request(app.getHttpServer()).get('/analytics/returns-summary').set(auth(noPermToken)).query({ locationId });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });

  it('purchasing-summary only counts APPROVED/SENT_TO_SUPPLIER/RECEIVED as spend, but counts every status in byStatus', async () => {
    const supplierA = await prisma.supplier.create({ data: { name: 'مورد أ' } });
    const supplierB = await prisma.supplier.create({ data: { name: 'مورد ب' } });
    await prisma.purchaseOrder.create({ data: { locationId, supplierId: supplierA.id, status: 'APPROVED', totalAmount: 100, createdById: userId } });
    await prisma.purchaseOrder.create({ data: { locationId, supplierId: supplierB.id, status: 'RECEIVED', totalAmount: 50, createdById: userId } });
    await prisma.purchaseOrder.create({ data: { locationId, supplierId: supplierA.id, status: 'DRAFT', totalAmount: 999, createdById: userId } });
    await prisma.purchaseOrder.create({ data: { locationId, supplierId: supplierA.id, status: 'CANCELLED', totalAmount: 777, createdById: userId } });

    const res = await request(app.getHttpServer()).get('/analytics/purchasing-summary').set(auth(viewToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(4);
    expect(res.body.totalSpend).toBe(150); // 100 + 50, DRAFT/CANCELLED excluded

    const statusCounts = Object.fromEntries(res.body.byStatus.map((s: { status: string; count: number }) => [s.status, s.count]));
    expect(statusCounts.APPROVED).toBe(1);
    expect(statusCounts.RECEIVED).toBe(1);
    expect(statusCounts.DRAFT).toBe(1);
    expect(statusCounts.CANCELLED).toBe(1);

    expect(res.body.topSuppliers[0]).toEqual({ supplierName: 'مورد أ', spend: 100 });
    expect(res.body.topSuppliers[1]).toEqual({ supplierName: 'مورد ب', spend: 50 });
  });

  it('returns-summary aggregates refund total and most-returned items', async () => {
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار تقرير مرتجعات', category: 'رئيسي', price: 10 } });
    const order = await prisma.order.create({
      data: {
        locationId,
        channel: 'DINE_IN',
        status: 'PAID',
        subtotal: 30,
        discountTotal: 0,
        vatTotal: 4.5,
        grandTotal: 34.5,
      },
    });
    const orderLine = await prisma.orderLine.create({ data: { orderId: order.id, menuItemId: menuItem.id, quantity: 3, unitPrice: 10 } });

    const return1 = await prisma.orderReturn.create({ data: { orderId: order.id, refundTotal: 11.5, createdById: userId } });
    await prisma.orderReturnLine.create({ data: { returnId: return1.id, orderLineId: orderLine.id, quantity: 1, refundAmount: 11.5 } });
    const return2 = await prisma.orderReturn.create({ data: { orderId: order.id, refundTotal: 23, createdById: userId } });
    await prisma.orderReturnLine.create({ data: { returnId: return2.id, orderLineId: orderLine.id, quantity: 2, refundAmount: 23 } });

    const res = await request(app.getHttpServer()).get('/analytics/returns-summary').set(auth(viewToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.returnCount).toBe(2);
    expect(res.body.totalRefund).toBe(34.5);
    expect(res.body.topReturnedItems[0]).toEqual({ name: 'صنف اختبار تقرير مرتجعات', quantity: 3 });
  });

  it('date-range filtering excludes rows outside the window for both reports', async () => {
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const farFutureEnd = new Date(Date.now() + 401 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const purchasing = await request(app.getHttpServer())
      .get('/analytics/purchasing-summary')
      .set(auth(viewToken))
      .query({ locationId, from: farFuture, to: farFutureEnd });
    expect(purchasing.body.orderCount).toBe(0);

    const returns = await request(app.getHttpServer())
      .get('/analytics/returns-summary')
      .set(auth(viewToken))
      .query({ locationId, from: farFuture, to: farFutureEnd });
    expect(returns.body.returnCount).toBe(0);
  });
});
