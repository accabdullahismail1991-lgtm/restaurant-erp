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
  let locationId: string;
  let ingredientId: string;
  let menuItemId: string;

  const MANAGE_PHONE = '+966500000160';
  const NOPERM_PHONE = '+966500000161';
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
    await prisma.user.deleteMany({ where: { phone: { in: [MANAGE_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['Returns-Test-Manager', 'Returns-Test-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: 'pos.return_order' } });

    const returnPerm = await prisma.permission.create({ data: { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' } });
    // pos.void_order may already exist (seeded globally / created by another
    // suite sharing this DB) -- upsert rather than create so this doesn't
    // collide with its unique `code` regardless of run order.
    const voidPerm = await prisma.permission.upsert({
      where: { code: 'pos.void_order' },
      update: {},
      create: { code: 'pos.void_order', label: 'إلغاء طلب' },
    });
    const role = await prisma.role.create({ data: { name: 'Returns-Test-Manager' } });
    await prisma.rolePermission.createMany({ data: [returnPerm, voidPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });
    await prisma.role.create({ data: { name: 'Returns-Test-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    manageToken = await makeUser(MANAGE_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

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
});
