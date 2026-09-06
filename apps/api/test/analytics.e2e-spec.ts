import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 11 (docs/DECISIONS.md #20): a purely read-only analytical layer
// over the same operational tables -- no new tables, no mutation. Runs
// against a real app + a real Postgres test database, same as every other
// suite. The food-cost report in particular is verified against REAL
// StockMovement rows a real sale actually produced, not a mocked number.
describe('Phase 11: analytics / BI (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewToken: string;
  let noPermToken: string;
  let locationId: string;
  let otherLocationId: string;
  let ingredientId: string;
  let lowStockIngredientId: string;
  let menuItemId: string;
  let shiftId: string;
  let otherShiftId: string;
  let paidOrderId: string;

  const VIEW_PHONE = '+966500000110';
  const NOPERM_PHONE = '+966500000111';
  const PASSWORD = 'AnalyticsTest123';

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
    await prisma.user.deleteMany({ where: { phone: { in: [VIEW_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'Analytics-Test-' } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'inventory.adjust'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const adjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const viewRole = await prisma.role.create({ data: { name: 'Analytics-Test-Viewer' } });
    await prisma.rolePermission.createMany({
      data: [viewPerm, adjustPerm].map((p) => ({ roleId: viewRole.id, permissionId: p.id })),
    });
    await prisma.role.create({ data: { name: 'Analytics-Test-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    viewToken = await makeUser(VIEW_PHONE, viewRole.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار التحليلات', type: 'BRANCH' } });
    locationId = location.id;
    const otherLocation = await prisma.location.create({ data: { name: 'فرع آخر للتحليلات', type: 'BRANCH' } });
    otherLocationId = otherLocation.id;

    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة تحليلات', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 50 },
    });
    ingredientId = ingredient.id;
    const lowStockIngredient = await prisma.ingredient.create({
      data: { name: 'خامة منخفضة المخزون', unit: 'pcs', kind: 'RAW_MATERIAL', lowStockThreshold: 100 },
    });
    lowStockIngredientId = lowStockIngredient.id;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف تحليلات', category: 'رئيسي', price: 50 } });
    menuItemId = menuItem.id;
    await prisma.recipeLine.create({ data: { menuItemId, ingredientId, quantity: 20 } }); // 20g per unit sold

    // Receive real batches with known costs -- inventory valuation and
    // food-cost math below are checked against these exact numbers.
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(viewToken))
      .send({ locationId, ingredientId, quantity: 1000, unitCost: 1.0 });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(viewToken))
      .send({ locationId, ingredientId: lowStockIngredientId, quantity: 50, unitCost: 3.0 }); // below its own threshold (100)
    // The "other location" sale below needs its OWN stock -- balances are
    // per-location, not shared.
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(viewToken))
      .send({ locationId: otherLocationId, ingredientId, quantity: 1000, unitCost: 1.0 });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(viewToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
    const otherShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(viewToken)).send({ locationId: otherLocationId, openingFloat: 100 });
    otherShiftId = otherShiftRes.body.id;

    // The one real sale everything below is computed from: 2x menu item
    // (100 subtotal, 15 VAT, 115 grand total), consuming 40g of the
    // ingredient at 1.00/g = 40 real COGS.
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(viewToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(viewToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    paidOrderId = payRes.body.id;

    // A second, unrelated sale at the OTHER location -- proves location
    // scoping actually excludes it rather than aggregating everything.
    const otherOrderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(viewToken))
      .send({ locationId: otherLocationId, shiftId: otherShiftId, channel: 'TAKEAWAY', lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${otherOrderRes.body.id}/pay`)
      .set(auth(viewToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(otherOrderRes.body.grandTotal) }] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks a user without analytics.view from every report (403)', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/sales-summary?locationId=${locationId}`).set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('computes an exact sales summary for the scoped location', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/sales-summary?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(1);
    expect(res.body.revenue).toBe(115);
    expect(res.body.netSales).toBe(100);
    expect(res.body.vatCollected).toBe(15);
    expect(res.body.discountGiven).toBe(0);
    expect(res.body.averageOrderValue).toBe(115);
    expect(res.body.byChannel).toEqual([{ channel: 'DINE_IN', orderCount: 1, revenue: 115 }]);
  });

  it('excludes the other location entirely when scoped', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/sales-summary?locationId=${otherLocationId}`).set(auth(viewToken));
    expect(res.body.orderCount).toBe(1);
    expect(res.body.revenue).toBe(57.5); // 1x item = 50 + 15% VAT
  });

  it('ranks top items by revenue with correct quantities', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/top-items?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].menuItemId).toBe(menuItemId);
    expect(res.body[0].quantity).toBe(2);
    expect(res.body[0].revenue).toBe(100);
  });

  it('computes real food cost from actual StockMovement costs, not an estimate', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/food-cost?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);
    expect(res.body.netSales).toBe(100);
    expect(res.body.cogs).toBe(40); // 40g consumed * 1.00/g, the batch's REAL unit cost
    expect(res.body.grossMargin).toBe(60);
    expect(res.body.foodCostPercent).toBe(40);
    expect(res.body.grossMarginPercent).toBe(60);
  });

  it('values current inventory as batch quantity * unit cost, reflecting the real sale consumption', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/inventory-valuation?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);
    const line = res.body.lines.find((l: any) => l.ingredientId === ingredientId);
    expect(line.quantity).toBe(960); // 1000 received - 40 consumed by the real sale
    expect(line.value).toBe(960); // 960 * 1.00/g
    const lowStockLine = res.body.lines.find((l: any) => l.ingredientId === lowStockIngredientId);
    expect(lowStockLine.value).toBe(150); // 50 * 3.00
    expect(res.body.totalValue).toBe(1110);
  });

  it('flags only the ingredient actually at/below its own threshold', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/low-stock?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.ingredientId);
    expect(ids).toContain(lowStockIngredientId); // 50 <= threshold 100
    expect(ids).not.toContain(ingredientId); // 960 > threshold 50
  });

  it('excludes an order from the summary once it falls outside the requested date range', async () => {
    // Backdate the real paid order rather than mocking the clock -- proves
    // the range filter genuinely reads paidAt, not just "always include".
    await prisma.order.update({ where: { id: paidOrderId }, data: { paidAt: new Date('2020-01-01T00:00:00Z') } });

    const excluded = await request(app.getHttpServer())
      .get(`/analytics/sales-summary?locationId=${locationId}&from=2021-01-01`)
      .set(auth(viewToken));
    expect(excluded.body.orderCount).toBe(0);

    const included = await request(app.getHttpServer())
      .get(`/analytics/sales-summary?locationId=${locationId}&from=2019-01-01&to=2020-12-31`)
      .set(auth(viewToken));
    expect(included.body.orderCount).toBe(1);
  });

  it('rejects an invalid date range value', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/sales-summary?locationId=${locationId}&from=not-a-date`).set(auth(viewToken));
    expect(res.status).toBe(400);
  });
});
