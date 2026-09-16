import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase C: customer returns -- for a PAID order only, partial or full per
// line, restocking the recipe's ingredients and recording an explicit
// refund amount. Runs against a real app + a real Postgres test database.
describe('Returns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manageToken: string;
  let noPermToken: string;
  let overrideToken: string;
  let voidPaidToken: string;
  let locationId: string;
  let ingredientId: string;
  let menuItemId: string;

  const MANAGE_PHONE = '+966500000160';
  const NOPERM_PHONE = '+966500000161';
  const OVERRIDE_PHONE = '+966500000162';
  const VOID_PAID_PHONE = '+966500000163';
  const PASSWORD = 'ReturnsTest123';

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
    await prisma.user.deleteMany({ where: { phone: { in: [MANAGE_PHONE, NOPERM_PHONE, OVERRIDE_PHONE, VOID_PAID_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['Returns-Test-Manager', 'Returns-Test-NoPerm', 'Returns-Test-Override', 'Returns-Test-VoidPaid'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['pos.return_order', 'pos.override_kitchen_block', 'pos.void_paid_order'] } } });

    const returnPerm = await prisma.permission.create({ data: { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' } });
    const overridePerm = await prisma.permission.create({ data: { code: 'pos.override_kitchen_block', label: 'تجاوز حظر إرجاع صنف لم يخرج من المطبخ بعد' } });
    const voidPaidPerm = await prisma.permission.create({ data: { code: 'pos.void_paid_order', label: 'إلغاء فاتورة مدفوعة بالكامل' } });
    // pos.void_order may already exist (seeded globally / created by another
    // suite sharing this DB) -- upsert rather than create so this doesn't
    // collide with its unique `code` regardless of run order.
    const voidPerm = await prisma.permission.upsert({
      where: { code: 'pos.void_order' },
      update: {},
      create: { code: 'pos.void_order', label: 'إلغاء طلب' },
    });
    // manageToken opens shifts as scaffolding below -- same upsert reasoning
    // as pos.void_order above.
    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    // Manual-discount permission -- needed by the return-pricing describe
    // block below to place a discounted order and verify the return
    // prorates it correctly. Upserted for the same shared-DB reason as
    // pos.void_order/pos.manage_shift above.
    const discountPerm = await prisma.permission.upsert({
      where: { code: 'pos.apply_discount' },
      update: {},
      create: { code: 'pos.apply_discount', label: 'تطبيق خصم يدوي على فاتورة مبيعات' },
    });
    const role = await prisma.role.create({ data: { name: 'Returns-Test-Manager' } });
    await prisma.rolePermission.createMany({ data: [returnPerm, voidPerm, shiftPerm, discountPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });
    await prisma.role.create({ data: { name: 'Returns-Test-NoPerm' } });
    // Holds pos.return_order (can submit a return at all) but deliberately
    // NOT pos.override_kitchen_block -- isolates the override permission
    // check below from the base return permission.
    const overrideRole = await prisma.role.create({ data: { name: 'Returns-Test-Override' } });
    await prisma.rolePermission.createMany({ data: [returnPerm, shiftPerm, overridePerm].map((p) => ({ roleId: overrideRole.id, permissionId: p.id })) });
    // Holds pos.void_paid_order (and the shift/create scaffolding it needs
    // to set up its own test orders) -- isolated from manageToken so the
    // "lacks pos.void_paid_order" negative test can reuse manageToken
    // without also holding this permission.
    const voidPaidRole = await prisma.role.create({ data: { name: 'Returns-Test-VoidPaid' } });
    await prisma.rolePermission.createMany({ data: [shiftPerm, voidPaidPerm].map((p) => ({ roleId: voidPaidRole.id, permissionId: p.id })) });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    manageToken = await makeUser(MANAGE_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);
    overrideToken = await makeUser(OVERRIDE_PHONE, overrideRole.id);
    voidPaidToken = await makeUser(VOID_PAID_PHONE, voidPaidRole.id);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار المرتجعات', type: 'BRANCH' } });
    locationId = location.id;

    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة اختبار مرتجعات', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    ingredientId = ingredient.id;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار مرتجعات', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;
    await prisma.recipeLine.create({ data: { menuItemId, ingredientId, quantity: 3 } });
  });

  afterAll(async () => {
    await app.close();
  });

  let paidOrderId: string;
  let orderLineId: string;

  async function placeAndPayOrder(quantity: number) {
    // Receive enough stock for this order.
    await prisma.inventoryBatch.create({
      data: { locationId, ingredientId, batchNumber: 'RET-TEST-' + Date.now(), quantity: quantity * 3, unitCost: 2, sourceType: 'ADJUSTMENT' },
    });
    await prisma.inventoryBalance.upsert({
      where: { ingredientId_locationId: { ingredientId, locationId } },
      update: { quantity: { increment: quantity * 3 } },
      create: { ingredientId, locationId, quantity: quantity * 3 },
    });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(manageToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity }] });
    expect(orderRes.status).toBe(201);
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(manageToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    expect(payRes.status).toBe(200);
    // A return is only allowed once the kitchen has finished the line
    // (READY/SERVED) -- QUEUED -> PREPARING -> READY, two bumps.
    const lineId = orderRes.body.lines[0].id;
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(manageToken));
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(manageToken));
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    return payRes.body;
  }

  it('rejects a return for an order that is not PAID yet', async () => {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
    const shiftId = shiftRes.body.id;
    await prisma.inventoryBatch.create({
      data: { locationId, ingredientId, batchNumber: 'RET-UNPAID-' + Date.now(), quantity: 30, unitCost: 2, sourceType: 'ADJUSTMENT' },
    });
    await prisma.inventoryBalance.upsert({
      where: { ingredientId_locationId: { ingredientId, locationId } },
      update: { quantity: { increment: 30 } },
      create: { ingredientId, locationId, quantity: 30 },
    });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(manageToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const unpaidLineId = orderRes.body.lines[0].id;

    const res = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: orderRes.body.id, lines: [{ orderLineId: unpaidLineId, quantity: 1 }] });
    expect(res.status).toBe(400);

    // Void it (never paid) so it doesn't block this shift's close below.
    await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/void`).set(auth(manageToken));
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
  });

  it('sets up a PAID order with 3 units for the rest of the suite', async () => {
    const order = await placeAndPayOrder(3);
    paidOrderId = order.id;
    orderLineId = order.lines[0].id;
    expect(order.status).toBe('PAID');
  });

  it('blocks a return while the line has not left the kitchen yet (still QUEUED)', async () => {
    await prisma.inventoryBatch.create({
      data: { locationId, ingredientId, batchNumber: 'RET-KITCHEN-' + Date.now(), quantity: 3, unitCost: 2, sourceType: 'ADJUSTMENT' },
    });
    await prisma.inventoryBalance.upsert({
      where: { ingredientId_locationId: { ingredientId, locationId } },
      update: { quantity: { increment: 3 } },
      create: { ingredientId, locationId, quantity: 3 },
    });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(manageToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(manageToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    expect(payRes.status).toBe(200); // line stays QUEUED -- never advanced

    const stillQueuedLineId = payRes.body.lines[0].id;
    const returnableRes = await request(app.getHttpServer())
      .get(`/returns/order/${payRes.body.id}/returnable-lines`)
      .set(auth(manageToken));
    expect(returnableRes.body.find((l: { orderLineId: string }) => l.orderLineId === stillQueuedLineId).kitchenStatus).toBe('QUEUED');

    const res = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: payRes.body.id, lines: [{ orderLineId: stillQueuedLineId, quantity: 1 }] });
    expect(res.status).toBe(400);

    // Advancing to READY (2 bumps) then makes the same return succeed.
    await request(app.getHttpServer()).post(`/kitchen/lines/${stillQueuedLineId}/advance`).set(auth(manageToken));
    await request(app.getHttpServer()).post(`/kitchen/lines/${stillQueuedLineId}/advance`).set(auth(manageToken));
    const res2 = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: payRes.body.id, lines: [{ orderLineId: stillQueuedLineId, quantity: 1 }] });
    expect(res2.status).toBe(201);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
  });

  it('rejects overrideKitchenBlock:true from a user who lacks pos.override_kitchen_block -- same 400 as not sending it', async () => {
    await prisma.inventoryBatch.create({
      data: { locationId, ingredientId, batchNumber: 'RET-OVERRIDE-' + Date.now(), quantity: 3, unitCost: 2, sourceType: 'ADJUSTMENT' },
    });
    await prisma.inventoryBalance.upsert({
      where: { ingredientId_locationId: { ingredientId, locationId } },
      update: { quantity: { increment: 3 } },
      create: { ingredientId, locationId, quantity: 3 },
    });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(manageToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(manageToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    const queuedLineId = payRes.body.lines[0].id;

    // manageToken holds pos.return_order but NOT pos.override_kitchen_block --
    // the flag alone must not be enough.
    const blocked = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: payRes.body.id, lines: [{ orderLineId: queuedLineId, quantity: 1 }], overrideKitchenBlock: true });
    expect(blocked.status).toBe(400);

    // overrideToken holds BOTH pos.return_order and pos.override_kitchen_block --
    // the same request now succeeds, and the override is logged on the order.
    const allowed = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(overrideToken))
      .send({ orderId: payRes.body.id, lines: [{ orderLineId: queuedLineId, quantity: 1 }], overrideKitchenBlock: true });
    expect(allowed.status).toBe(201);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: payRes.body.id }, include: { activityLog: true } });
    const actions = order.activityLog.map((a) => a.action);
    expect(actions).toContain('RETURNED');
    expect(actions).toContain('RETURN_KITCHEN_BLOCK_OVERRIDDEN');

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
  });

  it('blocks creating a return without pos.return_order (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(noPermToken))
      .send({ orderId: paidOrderId, lines: [{ orderLineId, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it('returnable-lines reports the full quantity available before any return', async () => {
    const res = await request(app.getHttpServer()).get(`/returns/order/${paidOrderId}/returnable-lines`).set(auth(manageToken));
    expect(res.status).toBe(200);
    const line = res.body.find((l: { orderLineId: string }) => l.orderLineId === orderLineId);
    expect(line.quantity).toBe(3);
    expect(line.alreadyReturned).toBe(0);
    expect(line.remaining).toBe(3);
  });

  it('creates a partial return (1 of 3), computes refund with VAT, and restocks inventory', async () => {
    const balanceBefore = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });

    const res = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: paidOrderId, reason: 'العميل غيّر رأيه', lines: [{ orderLineId, quantity: 1 }] });
    expect(res.status).toBe(201);
    // unitPrice 20 * 1 * 1.15 VAT = 23
    expect(Number(res.body.refundTotal)).toBe(23);
    expect(res.body.lines[0].quantity).toBe(1);

    // Recipe line was 3g per unit -- returning 1 unit restocks 3g.
    const balanceAfter = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });
    expect(Number(balanceAfter!.quantity) - Number(balanceBefore!.quantity)).toBe(3);
  });

  it('returnable-lines now reflects the partial return', async () => {
    const res = await request(app.getHttpServer()).get(`/returns/order/${paidOrderId}/returnable-lines`).set(auth(manageToken));
    const line = res.body.find((l: { orderLineId: string }) => l.orderLineId === orderLineId);
    expect(line.alreadyReturned).toBe(1);
    expect(line.remaining).toBe(2);
  });

  it('rejects returning more than what remains (cumulative across returns)', async () => {
    const res = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: paidOrderId, lines: [{ orderLineId, quantity: 3 }] }); // only 2 remain
    expect(res.status).toBe(400);
  });

  it('a second return covering the rest (2 more) succeeds and returnable then shows 0 remaining', async () => {
    const res = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(manageToken))
      .send({ orderId: paidOrderId, lines: [{ orderLineId, quantity: 2 }] });
    expect(res.status).toBe(201);

    const check = await request(app.getHttpServer()).get(`/returns/order/${paidOrderId}/returnable-lines`).set(auth(manageToken));
    const line = check.body.find((l: { orderLineId: string }) => l.orderLineId === orderLineId);
    expect(line.remaining).toBe(0);
  });

  it('lists returns for the location, newest first, with order + item details', async () => {
    const res = await request(app.getHttpServer()).get('/returns').set(auth(manageToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].order.id).toBe(paidOrderId);
    expect(res.body[0].lines[0].orderLine.menuItem.name).toBe('صنف اختبار مرتجعات');
  });

  describe('voidPaidOrder -- full cancellation of a PAID order', () => {
    async function placeAndPayFreshOrder(quantity: number) {
      await prisma.inventoryBatch.create({
        data: { locationId, ingredientId, batchNumber: 'VOID-TEST-' + Date.now(), quantity: quantity * 3, unitCost: 2, sourceType: 'ADJUSTMENT' },
      });
      await prisma.inventoryBalance.upsert({
        where: { ingredientId_locationId: { ingredientId, locationId } },
        update: { quantity: { increment: quantity * 3 } },
        create: { ingredientId, locationId, quantity: quantity * 3 },
      });
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
      const shiftId = shiftRes.body.id;
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity }] });
      const payRes = await request(app.getHttpServer())
        .post(`/orders/${orderRes.body.id}/pay`)
        .set(auth(manageToken))
        .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
      return { order: payRes.body, shiftId };
    }

    it('rejects without pos.void_paid_order (403)', async () => {
      const { order, shiftId } = await placeAndPayFreshOrder(2);
      const res = await request(app.getHttpServer()).post(`/returns/void-paid-order/${order.id}`).set(auth(manageToken));
      expect(res.status).toBe(403);
      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    });

    it('rejects voiding an order that is not PAID (400)', async () => {
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
      const shiftId = shiftRes.body.id;
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
      const res = await request(app.getHttpServer()).post(`/returns/void-paid-order/${orderRes.body.id}`).set(auth(voidPaidToken));
      expect(res.status).toBe(400);
      await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/void`).set(auth(manageToken));
      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    });

    it('rejects an order carrying a combo line, even one holding pos.void_paid_order', async () => {
      const combo = await prisma.comboMeal.create({ data: { name: 'كمبو اختبار الإلغاء', basePrice: 15 } });
      const { order, shiftId } = await placeAndPayFreshOrder(1);
      // Simulate a combo line on this order directly (bypassing the full
      // combo-selection order flow, which is out of scope for this test) --
      // enough to exercise voidPaidOrder's own combo-line rejection.
      await prisma.orderLine.update({ where: { id: order.lines[0].id }, data: { comboMealId: combo.id, menuItemId: null } });

      const res = await request(app.getHttpServer()).post(`/returns/void-paid-order/${order.id}`).set(auth(voidPaidToken));
      expect(res.status).toBe(400);

      await prisma.orderLine.update({ where: { id: order.lines[0].id }, data: { comboMealId: null, menuItemId } });
      await request(app.getHttpServer()).post(`/returns/void-paid-order/${order.id}`).set(auth(voidPaidToken));
      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    });

    it('voids a QUEUED line ignoring the kitchen-block, restocks it, refunds it, and logs VOIDED', async () => {
      const { order, shiftId } = await placeAndPayFreshOrder(2);
      expect(order.lines[0].kitchenStatus).toBe('QUEUED'); // never advanced
      const balanceBefore = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });

      const res = await request(app.getHttpServer())
        .post(`/returns/void-paid-order/${order.id}`)
        .set(auth(voidPaidToken))
        .send({ reason: 'طلب مكرر بالخطأ' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('VOIDED');

      // unitPrice 20 * 2 * 1.15 VAT = 46, restocks 2*3g = 6g.
      const balanceAfter = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });
      expect(Number(balanceAfter!.quantity) - Number(balanceBefore!.quantity)).toBe(6);

      const fullOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { activityLog: true } });
      expect(fullOrder.status).toBe('VOIDED');
      const voidedEntry = fullOrder.activityLog.find((a) => a.action === 'VOIDED');
      expect(voidedEntry?.note).toBe('طلب مكرر بالخطأ');

      const returns = await request(app.getHttpServer()).get('/returns').set(auth(manageToken)).query({ locationId });
      const ret = returns.body.find((r: { order: { id: string } }) => r.order.id === order.id);
      expect(Number(ret.refundTotal)).toBe(46);

      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    });

    it('rejects re-voiding an already-VOIDED order (400)', async () => {
      const { order, shiftId } = await placeAndPayFreshOrder(1);
      await request(app.getHttpServer()).post(`/returns/void-paid-order/${order.id}`).set(auth(voidPaidToken));

      const res = await request(app.getHttpServer()).post(`/returns/void-paid-order/${order.id}`).set(auth(voidPaidToken));
      expect(res.status).toBe(400);

      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    });

    it('voiding an already-fully-returned order just flips status, without a second restock/refund', async () => {
      const { order, shiftId } = await placeAndPayFreshOrder(1);
      // Advance to READY then fully return it first via the normal path.
      await request(app.getHttpServer()).post(`/kitchen/lines/${order.lines[0].id}/advance`).set(auth(manageToken));
      await request(app.getHttpServer()).post(`/kitchen/lines/${order.lines[0].id}/advance`).set(auth(manageToken));
      const returnRes = await request(app.getHttpServer())
        .post('/returns')
        .set(auth(manageToken))
        .send({ orderId: order.id, lines: [{ orderLineId: order.lines[0].id, quantity: 1 }] });
      expect(returnRes.status).toBe(201);

      const balanceBefore = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });
      const res = await request(app.getHttpServer()).post(`/returns/void-paid-order/${order.id}`).set(auth(voidPaidToken));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('VOIDED');
      const balanceAfter = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });
      expect(Number(balanceAfter!.quantity)).toBe(Number(balanceBefore!.quantity)); // nothing left to restock

      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
    });
  });

  // A return must refund exactly what the original invoice charged for
  // that line -- previously the refund calc used a hardcoded flat 15% VAT
  // regardless of the item's real tax type, the branch's real VAT rate,
  // pricesIncludeVat, or any discount applied to the original order.
  describe('return refund pricing -- agrees with the original invoice', () => {
    async function placeAndReturn(opts: {
      locId: string;
      itemId: string;
      quantity: number;
      returnQuantity: number;
      discountTotal?: number;
    }) {
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId: opts.locId, openingFloat: 200 });
      const shiftId = shiftRes.body.id;
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId: opts.locId,
          shiftId,
          channel: 'DINE_IN',
          lines: [{ menuItemId: opts.itemId, quantity: opts.quantity }],
          ...(opts.discountTotal != null ? { discountTotal: opts.discountTotal } : {}),
        });
      expect(orderRes.status).toBe(201);
      const payRes = await request(app.getHttpServer())
        .post(`/orders/${orderRes.body.id}/pay`)
        .set(auth(manageToken))
        .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
      expect(payRes.status).toBe(200);
      const lineId = orderRes.body.lines[0].id;
      await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(manageToken));
      await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(manageToken));

      const returnRes = await request(app.getHttpServer())
        .post('/returns')
        .set(auth(manageToken))
        .send({ orderId: orderRes.body.id, lines: [{ orderLineId: lineId, quantity: opts.returnQuantity }] });
      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
      return { order: orderRes.body, returnRes };
    }

    it('a ZERO_RATED item is refunded with no VAT grossed up (not the flat 15%)', async () => {
      const item = await prisma.menuItem.create({ data: { name: 'صنف صفري الضريبة', category: 'اختبار', price: 20, taxType: 'ZERO_RATED' } });
      const { returnRes } = await placeAndReturn({ locId: locationId, itemId: item.id, quantity: 1, returnQuantity: 1 });
      expect(returnRes.status).toBe(201);
      // unitPrice 20, ZERO_RATED -> no VAT at all, unlike the old flat 20*1.15=23.
      expect(Number(returnRes.body.refundTotal)).toBe(20);
    });

    it('an EXEMPT item is likewise refunded with no VAT', async () => {
      const item = await prisma.menuItem.create({ data: { name: 'صنف معفى من الضريبة', category: 'اختبار', price: 30, taxType: 'EXEMPT' } });
      const { returnRes } = await placeAndReturn({ locId: locationId, itemId: item.id, quantity: 1, returnQuantity: 1 });
      expect(returnRes.status).toBe(201);
      expect(Number(returnRes.body.refundTotal)).toBe(30);
    });

    it('a pricesIncludeVat branch is refunded the tax-inclusive price, not price x 1.15', async () => {
      const inclLocation = await prisma.location.create({ data: { name: 'فرع ضريبة شاملة للسعر', type: 'BRANCH', pricesIncludeVat: true } });
      const item = await prisma.menuItem.create({ data: { name: 'صنف سعر شامل الضريبة', category: 'اختبار', price: 23 } });
      const { order, returnRes } = await placeAndReturn({ locId: inclLocation.id, itemId: item.id, quantity: 1, returnQuantity: 1 });
      expect(returnRes.status).toBe(201);
      expect(Number(order.grandTotal)).toBe(23); // VAT already embedded, nothing added on top.
      expect(Number(returnRes.body.refundTotal)).toBe(23); // not 23 * 1.15 = 26.45.
    });

    it("a branch on a non-default VAT rate is refunded at ITS rate, not the hardcoded 15%", async () => {
      const lowVatLocation = await prisma.location.create({ data: { name: 'فرع ضريبة 5%', type: 'BRANCH', vatRate: 5 } });
      const item = await prisma.menuItem.create({ data: { name: 'صنف فرع ضريبة منخفضة', category: 'اختبار', price: 20 } });
      const { order, returnRes } = await placeAndReturn({ locId: lowVatLocation.id, itemId: item.id, quantity: 1, returnQuantity: 1 });
      expect(returnRes.status).toBe(201);
      expect(Number(order.grandTotal)).toBe(21); // 20 + 5% VAT.
      expect(Number(returnRes.body.refundTotal)).toBe(21); // not 20 * 1.15 = 23.
    });

    it("prorates the original order's manual discount into a partial return", async () => {
      const item = await prisma.menuItem.create({ data: { name: 'صنف اختبار خصم المرتجع', category: 'اختبار', price: 20 } });
      // 2 units @ 20 = 40 subtotal, 10 discount -> taxable 30, vat 4.5, grandTotal 34.5.
      const { order, returnRes } = await placeAndReturn({ locId: locationId, itemId: item.id, quantity: 2, returnQuantity: 1, discountTotal: 10 });
      expect(Number(order.grandTotal)).toBe(34.5);
      expect(returnRes.status).toBe(201);
      // Returning half the line refunds half the discounted+taxed amount:
      // lineGross 20, discountShare 10*(20/40)=5, net 15, +15% VAT = 17.25 -- not the old flat 20*1.15=23.
      expect(Number(returnRes.body.refundTotal)).toBe(17.25);
    });

    it('returning the full discounted order refunds exactly what was charged (grandTotal)', async () => {
      const item = await prisma.menuItem.create({ data: { name: 'صنف اختبار خصم كامل المرتجع', category: 'اختبار', price: 20 } });
      const { order, returnRes } = await placeAndReturn({ locId: locationId, itemId: item.id, quantity: 2, returnQuantity: 2, discountTotal: 10 });
      expect(returnRes.status).toBe(201);
      expect(Number(returnRes.body.refundTotal)).toBe(Number(order.grandTotal));
    });
  });
});
