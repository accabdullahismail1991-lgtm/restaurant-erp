import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Daily consumption report: reads the existing StockMovement ledger (no new
// tracking mechanism) and buckets every real DEDUCTION by reason -- SALE
// (recipe consumption at the till), PRODUCTION_CONSUMPTION (used as another
// ingredient's own input), WASTE (the manual waste-recording screen).
// STOCKTAKE_ADJUSTMENT is deliberately excluded (a count correction, not
// consumption). This test engineers one ingredient with a known unit cost,
// sells a known quantity of it, and separately records a known waste
// quantity, then asserts the report attributes each exactly to its own
// reason with the real historical batch cost, not a recomputed estimate.
describe('Daily consumption report (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewToken: string;
  let locationId: string;
  let ingredientId: string;

  const VIEW_PHONE = '+966500000160';
  const PASSWORD = 'DailyConsumeTest123';
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
    await prisma.user.deleteMany({ where: { phone: VIEW_PHONE } });
    await prisma.role.deleteMany({ where: { name: 'DailyConsume-Test-Viewer' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'inventory.adjust'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const adjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const viewRole = await prisma.role.create({ data: { name: 'DailyConsume-Test-Viewer' } });
    await prisma.rolePermission.createMany({ data: [viewPerm, adjustPerm].map((p) => ({ roleId: viewRole.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: VIEW_PHONE, phone: VIEW_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: viewRole.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: VIEW_PHONE, password: PASSWORD });
    viewToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار الاستهلاك اليومي', type: 'BRANCH' } });
    locationId = location.id;

    const ingredient = await prisma.ingredient.create({
      data: { name: 'مكوّن اختبار الاستهلاك', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    ingredientId = ingredient.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار الاستهلاك', category: 'اختبار', price: 50 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId, quantity: 2 } });

    // Stock it at a known unit cost of 10, then sell 3 units (consuming
    // 2*3=6 of the ingredient at cost 10 -> SALE cost = 60) and separately
    // waste 4 (WASTE cost = 40) -- two independently-verifiable buckets.
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(viewToken))
      .send({ locationId, ingredientId, quantity: 1000, unitCost: 10 });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(viewToken)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(viewToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: 3 }] });
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(viewToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    await request(app.getHttpServer()).post('/inventory/waste').set(auth(viewToken)).send({ locationId, ingredientId, quantity: 4 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('attributes SALE and WASTE consumption to the same ingredient with the real historical batch cost', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/daily-consumption?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);

    const item = res.body.items.find((i: { ingredientId: string }) => i.ingredientId === ingredientId);
    expect(item).toBeDefined();
    expect(item.name).toBe('مكوّن اختبار الاستهلاك');
    expect(item.kind).toBe('RAW_MATERIAL');

    const sale = item.byReason.find((r: { reason: string }) => r.reason === 'SALE');
    const waste = item.byReason.find((r: { reason: string }) => r.reason === 'WASTE');
    const production = item.byReason.find((r: { reason: string }) => r.reason === 'PRODUCTION_CONSUMPTION');
    expect(sale).toMatchObject({ quantity: 6, cost: 60 });
    expect(waste).toMatchObject({ quantity: 4, cost: 40 });
    expect(production).toMatchObject({ quantity: 0, cost: 0 });
    expect(item.totalQty).toBe(10);
    expect(item.totalCost).toBe(100);

    const saleTotal = res.body.totals.byReason.find((r: { reason: string }) => r.reason === 'SALE');
    const wasteTotal = res.body.totals.byReason.find((r: { reason: string }) => r.reason === 'WASTE');
    expect(saleTotal.cost).toBeGreaterThanOrEqual(60);
    expect(wasteTotal.cost).toBeGreaterThanOrEqual(40);
  });

  it('blocks without analytics.view (403)', async () => {
    const NOPERM_PHONE = '+966500000161';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const res = await request(app.getHttpServer())
      .get(`/analytics/daily-consumption?locationId=${locationId}`)
      .set(auth(loginRes.body.accessToken));
    expect(res.status).toBe(403);
  });
});
