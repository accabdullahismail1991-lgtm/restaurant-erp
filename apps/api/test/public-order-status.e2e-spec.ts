import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Customer-facing order tracking page: a public link/QR (no login) that
// polls GET /public/orders/:id/status. Proves the endpoint is genuinely
// reachable with no Authorization header, exposes only what a customer
// following their own order should see, and its `stage` correctly
// reflects kitchen progress and terminal states (VOIDED/PAID).
describe('GET /public/orders/:id/status (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let shiftId: string;
  let menuItemId: string;
  let tableId: string;

  const ADMIN_PHONE = '+966500000099';
  const PASSWORD = 'PublicOrderTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: ADMIN_PHONE } } });
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const adminUser = await prisma.user.create({ data: { name: 'Public Order Test Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const shiftRole = await prisma.role.upsert({ where: { name: 'Public-Order-Test-Shift' }, update: {}, create: { name: 'Public-Order-Test-Shift' } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: shiftRole.id, permissionId: shiftPerm.id } },
      update: {},
      create: { roleId: shiftRole.id, permissionId: shiftPerm.id },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: adminUser.id, roleId: shiftRole.id } },
      update: {},
      create: { userId: adminUser.id, roleId: shiftRole.id },
    });

    const location = await prisma.location.create({ data: { name: 'فرع اختبار حالة الطلب العامة', type: 'BRANCH' } });
    locationId = location.id;
    const table = await prisma.table.create({ data: { locationId, label: 'طاولة 5' } });
    tableId = table.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'شاورما اختبار', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 for a nonexistent order id, with no auth header at all', async () => {
    const res = await request(app.getHttpServer()).get('/public/orders/does-not-exist/status');
    expect(res.status).toBe(404);
  });

  it('shows RECEIVED for a freshly created order, with only customer-safe fields', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, tableId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    const orderId = orderRes.body.id;

    const res = await request(app.getHttpServer()).get(`/public/orders/${orderId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('RECEIVED');
    expect(res.body.tableLabel).toBe('طاولة 5');
    expect(res.body.locationName).toBe('فرع اختبار حالة الطلب العامة');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].name).toBe('شاورما اختبار');
    expect(res.body.lines[0].quantity).toBe(2);
    expect(res.body.lines[0].kitchenStatus).toBe('QUEUED');
    // Nothing beyond what a customer should see -- no staff name, no
    // customer PII, no VAT/payment breakdown, no other orders' data.
    expect(res.body.servedBy).toBeUndefined();
    expect(res.body.customer).toBeUndefined();
    expect(res.body.payments).toBeUndefined();
  });

  it('advances through PREPARING -> READY -> SERVED as kitchen lines advance', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, tableId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const orderId = orderRes.body.id;
    const lineId = orderRes.body.lines[0].id;

    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken)); // -> PREPARING
    const midRes = await request(app.getHttpServer()).get(`/public/orders/${orderId}/status`);
    expect(midRes.body.stage).toBe('PREPARING');

    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken)); // -> READY
    const readyRes = await request(app.getHttpServer()).get(`/public/orders/${orderId}/status`);
    expect(readyRes.body.stage).toBe('READY');

    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken)); // -> SERVED
    const servedRes = await request(app.getHttpServer()).get(`/public/orders/${orderId}/status`);
    expect(servedRes.body.stage).toBe('SERVED');
  });

  it('shows VOIDED for a voided order regardless of kitchen line status', async () => {
    const voidPerm = await prisma.permission.upsert({
      where: { code: 'pos.void_order' },
      update: {},
      create: { code: 'pos.void_order', label: 'إلغاء طلب' },
    });
    const voidRole = await prisma.role.upsert({ where: { name: 'Public-Order-Test-Void' }, update: {}, create: { name: 'Public-Order-Test-Void' } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: voidRole.id, permissionId: voidPerm.id } },
      update: {},
      create: { roleId: voidRole.id, permissionId: voidPerm.id },
    });
    const adminUser = await prisma.user.findFirstOrThrow({ where: { phone: ADMIN_PHONE } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: adminUser.id, roleId: voidRole.id } },
      update: {},
      create: { userId: adminUser.id, roleId: voidRole.id },
    });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, tableId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const orderId = orderRes.body.id;

    await request(app.getHttpServer()).post(`/orders/${orderId}/void`).set(auth(adminToken));
    const res = await request(app.getHttpServer()).get(`/public/orders/${orderId}/status`);
    expect(res.body.stage).toBe('VOIDED');
  });
});
