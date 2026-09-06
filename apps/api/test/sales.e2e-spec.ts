import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Phase 3+4: inventory (batches/movements/balances) + sales (shifts,
// orders, payments, void) -- the "Sales <-> Items <-> Inventory" core
// integration point from docs/ARCHITECTURE.md. Runs against a real app +
// a real Postgres test database, same as the Phase 1/2 suites.
describe('Phase 3+4: inventory + sales (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let locationId: string;
  let ingredientId: string;
  let menuItemId: string;
  let zeroStockIngredientId: string;
  let zeroStockItemId: string;

  const ADMIN_PHONE = '+966500000020';
  const ADMIN_PASSWORD = 'AdminPass123';
  const NOPERM_PHONE = '+966500000021';
  const NOPERM_PASSWORD = 'NoPermPass123';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    // This suite owns every one of these tables fully -- no other suite
    // creates orders/shifts/payments/inventory rows, so a full wipe here
    // is safe (children before parents to satisfy FK constraints). It also
    // clears purchasing's tables defensively before ingredient -- this
    // suite runs after purchasing.e2e-spec.ts alphabetically, and that
    // suite's PurchaseOrderLine rows FK to Ingredient, so leftover ones
    // would otherwise break THIS suite's own ingredient cleanup (same
    // class of fix app.e2e-spec.ts and purchasing.e2e-spec.ts needed).
    await prisma.approval.deleteMany({});
    await prisma.purchaseOrderLine.deleteMany({});
    await prisma.purchaseOrder.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.orderLine.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.shift.deleteMany({});
    await prisma.stockMovement.deleteMany({});
    await prisma.inventoryBatch.deleteMany({});
    await prisma.inventoryBalance.deleteMany({});
    await prisma.recipeLine.deleteMany({});
    await prisma.menuItem.deleteMany({});
    await prisma.ingredient.deleteMany({});
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['Admin-Sales-Test', 'NoPerm-Sales-Test'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['inventory.adjust', 'pos.void_order'] } } });

    const inventoryAdjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const voidOrderPerm = await prisma.permission.create({ data: { code: 'pos.void_order', label: 'إلغاء طلب' } });
    const adminRole = await prisma.role.create({ data: { name: 'Admin-Sales-Test' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: adminRole.id, permissionId: inventoryAdjustPerm.id },
        { roleId: adminRole.id, permissionId: voidOrderPerm.id },
      ],
    });
    await prisma.role.create({ data: { name: 'NoPerm-Sales-Test' } });

    const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash: adminPasswordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

    const noPermPasswordHash = await bcrypt.hash(NOPERM_PASSWORD, 10);
    await prisma.user.create({ data: { name: 'NoPerm', phone: NOPERM_PHONE, passwordHash: noPermPasswordHash } });

    const adminLoginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = adminLoginRes.body.accessToken;
    const noPermLoginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: NOPERM_PASSWORD });
    noPermToken = noPermLoginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار المبيعات', type: 'BRANCH' } });
    locationId = location.id;

    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة اختبار', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    ingredientId = ingredient.id;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;
    await prisma.recipeLine.create({ data: { menuItemId, ingredientId, quantity: 3 } });

    // A second item whose ingredient is NEVER stocked -- used to prove an
    // order fails atomically (400, nothing persisted) when stock is short.
    const zeroStockIngredient = await prisma.ingredient.create({
      data: { name: 'خامة بدون رصيد', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    zeroStockIngredientId = zeroStockIngredient.id;
    const zeroStockItem = await prisma.menuItem.create({ data: { name: 'صنف بدون رصيد', category: 'رئيسي', price: 15 } });
    zeroStockItemId = zeroStockItem.id;
    await prisma.recipeLine.create({ data: { menuItemId: zeroStockItemId, ingredientId: zeroStockIngredientId, quantity: 1 } });
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('rejects placing an order when the recipe ingredient has zero stock (atomic, nothing persisted)', async () => {
    const beforeCount = await prisma.order.count();
    const shiftRes = await request(app.getHttpServer())
      .post('/shifts')
      .set(auth(adminToken))
      .send({ locationId, openingFloat: 200 });
    expect(shiftRes.status).toBe(201);
    const shiftId = shiftRes.body.id;

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: zeroStockItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(await prisma.order.count()).toBe(beforeCount);

    // close this throwaway shift so it doesn't block the "one open shift
    // per location" rule for the rest of the suite.
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(adminToken)).send({ closingCounted: 200 });
  });

  it('blocks a user without inventory.adjust from receiving stock (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(noPermToken))
      .send({ locationId, ingredientId, quantity: 100, unitCost: 5 });
    expect(res.status).toBe(403);
  });

  it('receives stock as an adjustment and reflects it in the balance', async () => {
    const res = await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId, ingredientId, quantity: 100, unitCost: 5 });
    expect(res.status).toBe(201);

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const balance = balances.body.find((b: any) => b.ingredientId === ingredientId);
    expect(Number(balance.quantity)).toBe(100);
  });

  it('rejects opening a second shift while one is already open for the location (409)', async () => {
    const openRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 200 });
    expect(openRes.status).toBe(201);

    const secondRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    expect(secondRes.status).toBe(409);
  });

  let shiftId: string;
  let orderAId: string;
  let orderCId: string;

  it('creates an order, deducting exactly recipe-quantity x line-quantity from inventory atomically', async () => {
    const openShift = await prisma.shift.findFirstOrThrow({ where: { locationId, closedAt: null } });
    shiftId = openShift.id;

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SENT_TO_KITCHEN');
    expect(Number(res.body.subtotal)).toBe(40);
    expect(Number(res.body.vatTotal)).toBe(6);
    expect(Number(res.body.grandTotal)).toBe(46);
    orderAId = res.body.id;

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const balance = balances.body.find((b: any) => b.ingredientId === ingredientId);
    expect(Number(balance.quantity)).toBe(94); // 100 - (3 * 2)
  });

  it('rejects paying an order with an amount that does not match its grand total', async () => {
    const res = await request(app.getHttpServer())
      .post(`/orders/${orderAId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: 10 }] });
    expect(res.status).toBe(400);
  });

  it('pays the order in full and marks it PAID', async () => {
    const res = await request(app.getHttpServer())
      .post(`/orders/${orderAId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: 46 }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
  });

  it('rejects paying an already-PAID order', async () => {
    const res = await request(app.getHttpServer())
      .post(`/orders/${orderAId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: 46 }] });
    expect(res.status).toBe(400);
  });

  it('pays a second order by CARD (not counted in cash reconciliation later)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'TAKEAWAY', lines: [{ menuItemId, quantity: 1 }] });
    expect(createRes.status).toBe(201);
    const orderBId = createRes.body.id;

    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderBId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CARD', mode: 'INTEGRATED', amount: 23, terminalRef: 'term-1' }] });
    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('PAID');
  });

  it('blocks a user without pos.void_order from voiding an order (403)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    orderCId = createRes.body.id;

    const res = await request(app.getHttpServer()).post(`/orders/${orderCId}/void`).set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('voids the unpaid order as an admin, restocking the ingredient it had consumed', async () => {
    const before = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const beforeQty = Number(before.body.find((b: any) => b.ingredientId === ingredientId).quantity);

    const res = await request(app.getHttpServer()).post(`/orders/${orderCId}/void`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VOIDED');

    const after = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const afterQty = Number(after.body.find((b: any) => b.ingredientId === ingredientId).quantity);
    expect(afterQty).toBe(beforeQty + 3); // the 1x order's recipe quantity restored
  });

  it('rejects voiding an already-PAID order', async () => {
    const res = await request(app.getHttpServer()).post(`/orders/${orderAId}/void`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it('rejects creating an order against a closed shift', async () => {
    const closeRes = await request(app.getHttpServer())
      .post(`/shifts/${shiftId}/close`)
      .set(auth(adminToken))
      .send({ closingCounted: 250 });
    expect(closeRes.status).toBe(200);

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('reconciles shift cash correctly: opening float + CASH-only PAID payments, vs what was actually counted', async () => {
    const shiftRes = await request(app.getHttpServer()).get(`/shifts/${shiftId}`).set(auth(adminToken));
    expect(shiftRes.status).toBe(200);
    // openingFloat 200 + one CASH payment of 46 (order A) -- the CARD
    // payment (order B) must NOT be counted.
    expect(Number(shiftRes.body.expectedCash)).toBe(246);
    expect(Number(shiftRes.body.closingCounted)).toBe(250);
    expect(Number(shiftRes.body.variance)).toBe(4);
  });
});
