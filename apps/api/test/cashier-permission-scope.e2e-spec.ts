import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// The newly finer-grained permission model: a plain cashier (a user with
// NO extra permissions at all, matching the seeded "كاشير" role template
// before any manager grants it something extra) should be blocked from
// opening/closing a shift and from browsing back-office data (recipes/
// costs, inventory, purchasing, production, transfers) -- but menu items,
// combos, customers, and branches stay open reads since the cashier needs
// those to actually sell. This suite proves the block is real (403, not
// silently ignored) and that granting the specific permission unblocks
// exactly that one thing.
describe('Finer-grained cashier permission scope (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bareToken: string;
  let bareUserId: string;
  let locationId: string;

  const BARE_PHONE = '+966500000097';
  const BARE_PASSWORD = 'BareCashierTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: BARE_PHONE } } });
    await prisma.user.deleteMany({ where: { phone: BARE_PHONE } });
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'Grant-Shift-Only-Test' } } });
    await prisma.role.deleteMany({ where: { name: 'Grant-Shift-Only-Test' } });

    const passwordHash = await bcrypt.hash(BARE_PASSWORD, 10);
    const bareUser = await prisma.user.create({ data: { name: 'Bare Cashier', phone: BARE_PHONE, passwordHash } });
    bareUserId = bareUser.id;
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: BARE_PHONE, password: BARE_PASSWORD });
    bareToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار صلاحيات الكاشير', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks a plain cashier from opening a shift (403)', async () => {
    const res = await request(app.getHttpServer()).post('/shifts').set(auth(bareToken)).send({ locationId, openingFloat: 100 });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('pos.manage_shift');
  });

  it('blocks a plain cashier from browsing ingredients/recipes/costs (403)', async () => {
    const res = await request(app.getHttpServer()).get('/ingredients').set(auth(bareToken));
    expect(res.status).toBe(403);
  });

  it('blocks a plain cashier from browsing inventory balances (403)', async () => {
    const res = await request(app.getHttpServer()).get('/inventory/balances').set(auth(bareToken));
    expect(res.status).toBe(403);
  });

  it('blocks a plain cashier from browsing suppliers/purchase orders (403)', async () => {
    const suppliers = await request(app.getHttpServer()).get('/suppliers').set(auth(bareToken));
    expect(suppliers.status).toBe(403);
    const pos = await request(app.getHttpServer()).get('/purchase-orders').set(auth(bareToken));
    expect(pos.status).toBe(403);
  });

  it('blocks a plain cashier from browsing production orders and transfers (403)', async () => {
    const production = await request(app.getHttpServer()).get('/production-orders').set(auth(bareToken));
    expect(production.status).toBe(403);
    const transfers = await request(app.getHttpServer()).get('/transfers').set(auth(bareToken));
    expect(transfers.status).toBe(403);
  });

  it('still lets a plain cashier read core POS data (branches, menu items) with no extra permission', async () => {
    const branches = await request(app.getHttpServer()).get('/locations').set(auth(bareToken));
    expect(branches.status).toBe(200);
    const items = await request(app.getHttpServer()).get('/items').set(auth(bareToken));
    expect(items.status).toBe(200);
  });

  it('unblocks shift opening once pos.manage_shift is granted, without unblocking anything else', async () => {
    const permission = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const role = await prisma.role.create({ data: { name: 'Grant-Shift-Only-Test' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.userRole.create({ data: { userId: bareUserId, roleId: role.id } });

    const openRes = await request(app.getHttpServer()).post('/shifts').set(auth(bareToken)).send({ locationId, openingFloat: 100 });
    expect(openRes.status).toBe(201);

    // still blocked from ingredients -- granting one permission didn't leak into another
    const stillBlocked = await request(app.getHttpServer()).get('/ingredients').set(auth(bareToken));
    expect(stillBlocked.status).toBe(403);

    const closeRes = await request(app.getHttpServer())
      .post(`/shifts/${openRes.body.id}/close`)
      .set(auth(bareToken))
      .send({ closingCounted: 100 });
    expect(closeRes.status).toBe(200);
  });
});
