import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// GET /analytics/negative-stock (what's actually wrong right now, and by
// how much) and POST /inventory/settle-negative-stock (the one-click fix)
// -- both read/act on InventoryBalance.quantity < 0, the real, unbacked
// debt InventoryService.consume() can leave behind when
// Location.allowNegativeStock lets a sale/use go past zero. Fixtures here
// write InventoryBalance rows directly rather than re-deriving a negative
// balance through a real oversold order -- that mechanism is already
// covered by negative-stock-production.e2e-spec.ts; this file only cares
// about what the report/settlement do with a balance that's already
// negative.
describe('Negative stock: report + bulk settlement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let noPermToken: string;
  let locationAId: string;
  let locationBId: string;
  let negIngredientAId: string;
  let positiveIngredientId: string;
  let negIngredientBId: string;

  const PHONE = '+966500000330';
  const NOPERM_PHONE = '+966500000331';
  const PASSWORD = 'NegStockTest123';
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
    await prisma.user.deleteMany({ where: { phone: { in: [PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['NegStock-Test', 'NegStock-Test-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'inventory.adjust'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const adjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const role = await prisma.role.create({ data: { name: 'NegStock-Test' } });
    await prisma.rolePermission.createMany({ data: [viewPerm, adjustPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });
    const noPermRole = await prisma.role.create({ data: { name: 'NegStock-Test-NoPerm' } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const noPermUser = await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: noPermUser.id, roleId: noPermRole.id } });

    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;
    const noPermLoginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    noPermToken = noPermLoginRes.body.accessToken;

    locationAId = (await prisma.location.create({ data: { name: 'فرع اختبار الرصيد السالب 1', type: 'BRANCH' } })).id;
    locationBId = (await prisma.location.create({ data: { name: 'فرع اختبار الرصيد السالب 2', type: 'BRANCH' } })).id;

    negIngredientAId = (await prisma.ingredient.create({ data: { name: 'صنف برصيد سالب أ', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } })).id;
    positiveIngredientId = (await prisma.ingredient.create({ data: { name: 'صنف برصيد موجب', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } })).id;
    negIngredientBId = (await prisma.ingredient.create({ data: { name: 'صنف برصيد سالب ب', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } })).id;

    // A: -15 at location A. Positive: +20 at location A (must never show up
    // as negative / never get touched by settlement). B: -3 at location B.
    await prisma.inventoryBalance.create({ data: { ingredientId: negIngredientAId, locationId: locationAId, quantity: -15 } });
    await prisma.inventoryBalance.create({ data: { ingredientId: positiveIngredientId, locationId: locationAId, quantity: 20 } });
    await prisma.inventoryBalance.create({ data: { ingredientId: negIngredientBId, locationId: locationBId, quantity: -3 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('negative-stock report lists only balances below zero, with correct quantity and location', async () => {
    const all = await request(app.getHttpServer()).get('/analytics/negative-stock').set(auth());
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);
    const rowA = all.body.find((r: any) => r.ingredientId === negIngredientAId);
    expect(rowA.name).toBe('صنف برصيد سالب أ');
    expect(rowA.quantity).toBe(-15);
    expect(rowA.locationId).toBe(locationAId);
    expect(rowA.locationName).toBe('فرع اختبار الرصيد السالب 1');
    const rowB = all.body.find((r: any) => r.ingredientId === negIngredientBId);
    expect(rowB.quantity).toBe(-3);
    expect(all.body.some((r: any) => r.ingredientId === positiveIngredientId)).toBe(false);

    const scoped = await request(app.getHttpServer()).get(`/analytics/negative-stock?locationId=${locationAId}`).set(auth());
    expect(scoped.body).toHaveLength(1);
    expect(scoped.body[0].ingredientId).toBe(negIngredientAId);
  });

  it('rejects negative-stock report without analytics.view (403)', async () => {
    const res = await request(app.getHttpServer()).get('/analytics/negative-stock').set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('rejects settle-negative-stock without inventory.adjust (403)', async () => {
    const res = await request(app.getHttpServer()).post('/inventory/settle-negative-stock').set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('settle-negative-stock scoped to one location settles only that location, leaving the other untouched', async () => {
    const res = await request(app.getHttpServer())
      .post(`/inventory/settle-negative-stock?locationId=${locationAId}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.settledCount).toBe(1);
    expect(res.body.results[0].ingredientId).toBe(negIngredientAId);
    expect(res.body.results[0].settled).toBe(true);
    expect(res.body.results[0].quantitySettled).toBe(15);

    const balanceA = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId: negIngredientAId, locationId: locationAId } } });
    expect(Number(balanceA?.quantity)).toBe(0);
    const balancePositive = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId: positiveIngredientId, locationId: locationAId } } });
    expect(Number(balancePositive?.quantity)).toBe(20); // untouched

    const balanceB = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId: negIngredientBId, locationId: locationBId } } });
    expect(Number(balanceB?.quantity)).toBe(-3); // still negative -- out of scope for this call

    // The settlement must be a REAL receive: a new batch + a positive
    // StockMovement, not a bare balance overwrite -- since there was no
    // open batch to price the original shortfall from, its cost is 0.
    const batch = await prisma.inventoryBatch.findFirst({ where: { ingredientId: negIngredientAId, locationId: locationAId, sourceType: 'ADJUSTMENT' } });
    expect(batch).toBeTruthy();
    expect(Number(batch?.quantity)).toBe(15);
    expect(Number(batch?.unitCost)).toBe(0);
    const movement = await prisma.stockMovement.findFirst({ where: { batchId: batch!.id, reason: 'NEGATIVE_STOCK_SETTLEMENT' } });
    expect(Number(movement?.quantity)).toBe(15);
  });

  it('settle-negative-stock with no locationId settles every remaining negative balance', async () => {
    const res = await request(app.getHttpServer()).post('/inventory/settle-negative-stock').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.settledCount).toBe(1); // only B is still negative at this point
    expect(res.body.results[0].ingredientId).toBe(negIngredientBId);
    expect(res.body.results[0].quantitySettled).toBe(3);

    const balanceB = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId: negIngredientBId, locationId: locationBId } } });
    expect(Number(balanceB?.quantity)).toBe(0);

    const stillNegative = await request(app.getHttpServer()).get('/analytics/negative-stock').set(auth());
    expect(stillNegative.body).toHaveLength(0);

    // Idempotent: nothing left to settle now.
    const again = await request(app.getHttpServer()).post('/inventory/settle-negative-stock').set(auth());
    expect(again.body.settledCount).toBe(0);
    expect(again.body.results).toHaveLength(0);
  });
});
