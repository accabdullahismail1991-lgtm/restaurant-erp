import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Pivot Table report builder: three flat, row-level data sources (Sales/
// Inventory/Purchasing) for the admin panel's client-side drag/drop pivot
// engine. Unlike every other analytics report, these hand back RAW rows
// (no server-side grouping) since the grouping is chosen by the user at
// view time -- these tests just confirm each route returns the right shape
// with the right numbers, not any particular aggregation.
describe('Analytics pivot-table data sources (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;

  const PHONE = '+966500000170';
  const PASSWORD = 'PivotTest123';
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
    await prisma.role.deleteMany({ where: { name: 'Pivot-Test-Role' } });
    await prisma.permission.deleteMany({
      where: { code: { in: ['analytics.view', 'pos.manage_shift', 'inventory.adjust', 'purchasing.create_po'] } },
    });

    const perms = await Promise.all(
      ['analytics.view', 'pos.manage_shift', 'inventory.adjust', 'purchasing.create_po'].map((code) =>
        prisma.permission.create({ data: { code, label: code } }),
      ),
    );
    const role = await prisma.role.create({ data: { name: 'Pivot-Test-Role' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار Pivot', type: 'BRANCH' } });
    locationId = location.id;

    // ---- Sales source: one paid order with one line ----
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار Pivot', category: 'رئيسي', price: 20 } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: 3 }] });
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    // ---- Inventory source: one stock adjustment (an IN movement) ----
    const ingredient = await prisma.ingredient.create({
      data: { name: 'مكوّن اختبار Pivot', category: 'خضروات', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId: ingredient.id, quantity: 50, unitCost: 4 });

    // ---- Purchasing source: one draft PO with one line ----
    const supplierRes = await request(app.getHttpServer())
      .post('/suppliers')
      .set(auth(token))
      .send({ name: 'مورّد اختبار Pivot' });
    await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(token))
      .send({ locationId, supplierId: supplierRes.body.id, lines: [{ ingredientId: ingredient.id, quantity: 10, unitCost: 5 }] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('pivot/sales returns one flat row per order line with revenue computed', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/pivot/sales?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { itemName: string }) => r.itemName === 'صنف اختبار Pivot');
    expect(row).toBeDefined();
    expect(row.category).toBe('رئيسي');
    expect(row.quantity).toBe(3);
    expect(row.unitPrice).toBe(20);
    expect(row.revenue).toBe(60);
    expect(row.locationName).toBe('فرع اختبار Pivot');
  });

  it('pivot/inventory returns one flat row per stock movement with value computed', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/pivot/inventory?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { ingredientName: string }) => r.ingredientName === 'مكوّن اختبار Pivot');
    expect(row).toBeDefined();
    expect(row.category).toBe('خضروات');
    expect(row.quantity).toBe(50);
    expect(row.unitCost).toBe(4);
    expect(row.value).toBe(200);
  });

  it('pivot/purchasing returns one flat row per PO line with total computed', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/pivot/purchasing?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { ingredientName: string }) => r.ingredientName === 'مكوّن اختبار Pivot');
    expect(row).toBeDefined();
    expect(row.supplierName).toBe('مورّد اختبار Pivot');
    expect(row.quantity).toBe(10);
    expect(row.unitCost).toBe(5);
    expect(row.total).toBe(50);
  });

  it('blocks all three routes without analytics.view (403)', async () => {
    const NOPERM_PHONE = '+966500000171';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const noPermAuth = auth(loginRes.body.accessToken);
    for (const path of ['sales', 'inventory', 'purchasing']) {
      const res = await request(app.getHttpServer()).get(`/analytics/pivot/${path}`).set(noPermAuth);
      expect(res.status).toBe(403);
    }
  });
});
