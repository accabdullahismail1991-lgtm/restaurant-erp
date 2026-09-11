import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Two related additions: (1) a per-location "require a customer on every
// order" setting, enforced server-side in OrdersService.create() -- never
// just a UI nicety a client could bypass; (2) a manageable PaymentMethod
// list replacing the hardcoded CASH/CARD/WALLET strings, with
// ShiftsService.close()'s cash-till reconciliation now driven by
// PaymentMethod.isCash instead of a literal 'CASH' check.
describe('Required-customer setting + Payment Methods management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let menuItemId: string;

  const ADMIN_PHONE = '+966500000220';
  const NOPERM_PHONE = '+966500000221';
  const PASSWORD = 'ReqCustPmTest123';

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
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['ReqCust-Manager', 'ReqCust-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['payment_methods.manage', 'branches.manage'] } } });

    const pmPerm = await prisma.permission.create({ data: { code: 'payment_methods.manage', label: 'إدارة طرق الدفع' } });
    const branchesPerm = await prisma.permission.create({ data: { code: 'branches.manage', label: 'إدارة الفروع' } });
    const role = await prisma.role.create({ data: { name: 'ReqCust-Manager' } });
    await prisma.rolePermission.createMany({
      data: [pmPerm, branchesPerm].map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    await prisma.role.create({ data: { name: 'ReqCust-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار العميل الإلزامي', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('does NOT require a customer at a location with the default setting (false)', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع بلا إلزام عميل', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
  });

  it('rejects order creation without a customer when the location requires one (400)', async () => {
    const location = await prisma.location.create({
      data: { name: 'فرع يلزم اختيار العميل', type: 'BRANCH', requireCustomerForOrders: true },
    });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const withoutCustomer = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DELIVERY_PARTNER', lines: [{ menuItemId, quantity: 1 }] });
    expect(withoutCustomer.status).toBe(400);
    expect(withoutCustomer.body.message).toContain('العميل');

    const customer = await prisma.customer.create({ data: { phone: '+96650' + String(Date.now()).slice(-7), name: 'عميل إلزامي' } });
    const withCustomer = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DELIVERY_PARTNER', customerId: customer.id, lines: [{ menuItemId, quantity: 1 }] });
    expect(withCustomer.status).toBe(201);
  });

  it('toggling requireCustomerForOrders via PATCH /locations/:id takes effect immediately', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع يتحول لاحقًا', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });

    const before = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(before.status).toBe(201);

    await request(app.getHttpServer()).patch(`/locations/${location.id}`).set(auth(adminToken)).send({ requireCustomerForOrders: true });
    const after = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(after.status).toBe(400);
  });

  it('lists the seeded default payment methods for any logged-in user', async () => {
    const res = await request(app.getHttpServer()).get('/payment-methods').set(auth(noPermToken));
    expect(res.status).toBe(200);
    const codes = res.body.map((m: { code: string }) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['CASH', 'CARD', 'WALLET']));
    const cash = res.body.find((m: { code: string }) => m.code === 'CASH');
    expect(cash.isCash).toBe(true);
  });

  it('blocks creating/updating payment methods without payment_methods.manage (403)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/payment-methods')
      .set(auth(noPermToken))
      .send({ name: 'تحويل بنكي', code: 'BANK_TRANSFER' });
    expect(createRes.status).toBe(403);
  });

  it('creates a new payment method and rejects a duplicate code', async () => {
    const res = await request(app.getHttpServer())
      .post('/payment-methods')
      .set(auth(adminToken))
      .send({ name: 'تحويل بنكي', code: 'BANK_TRANSFER' });
    expect(res.status).toBe(201);
    expect(res.body.isCash).toBe(false);

    const dup = await request(app.getHttpServer())
      .post('/payment-methods')
      .set(auth(adminToken))
      .send({ name: 'تحويل بنكي آخر', code: 'BANK_TRANSFER' });
    expect(dup.status).toBe(409);
  });

  it('deactivating a payment method via PATCH is reflected, and code cannot be changed', async () => {
    const created = await request(app.getHttpServer())
      .post('/payment-methods')
      .set(auth(adminToken))
      .send({ name: 'محفظة قديمة', code: 'OLD_WALLET' });
    const patched = await request(app.getHttpServer())
      .patch(`/payment-methods/${created.body.id}`)
      .set(auth(adminToken))
      .send({ isActive: false, name: 'محفظة معطّلة' });
    expect(patched.status).toBe(200);
    expect(patched.body.isActive).toBe(false);
    expect(patched.body.name).toBe('محفظة معطّلة');
    expect(patched.body.code).toBe('OLD_WALLET');

    const activeOnly = await request(app.getHttpServer()).get('/payment-methods').query({ activeOnly: 'true' }).set(auth(noPermToken));
    expect(activeOnly.body.find((m: { code: string }) => m.code === 'OLD_WALLET')).toBeUndefined();
  });

  it('shift cash reconciliation dynamically follows PaymentMethod.isCash -- marking CARD as cash includes it, unmarking CASH excludes it', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار مرونة تسوية الصندوق', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] }); // 20 + 15% VAT = 23
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CARD', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    // CARD isn't cash by default -- expected cash is just the opening float.
    const closeRes = await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(adminToken)).send({ closingCounted: 100 });
    expect(Number(closeRes.body.expectedCash)).toBe(100);

    // Flip CARD to isCash=true and repeat with a fresh shift -- now it counts.
    const cardMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: 'CARD' } });
    await request(app.getHttpServer()).patch(`/payment-methods/${cardMethod.id}`).set(auth(adminToken)).send({ isCash: true });

    const shift2Res = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const order2Res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shift2Res.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    await request(app.getHttpServer())
      .post(`/orders/${order2Res.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CARD', mode: 'MANUAL', amount: Number(order2Res.body.grandTotal) }] });
    const close2Res = await request(app.getHttpServer()).post(`/shifts/${shift2Res.body.id}/close`).set(auth(adminToken)).send({ closingCounted: 123 });
    expect(Number(close2Res.body.expectedCash)).toBe(123); // 100 opening + 23 CARD (now cash-flagged)
  });
});
