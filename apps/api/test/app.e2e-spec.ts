import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Runs against a REAL Postgres database (restaurant_erp_test, migrated
// separately -- see .env.test) and a REAL running Nest app instance, not
// mocks -- this is the same slice of behavior verified manually with curl
// while building Phase 1, turned into something that stays true after
// the next change.
describe('Phase 1: auth + RBAC + users + branches (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const ADMIN_PHONE = '+966500000001';
  const ADMIN_PASSWORD = 'AdminPass123';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    // Clean slate: this suite owns its rows, identified by the +9665000
    // test-phone prefix, so re-runs don't accumulate duplicate seed data
    // or collide with anything a developer seeded manually in this DB.
    // resetDatabase() clears every other suite's domain tables first (see
    // test/reset-db.ts) so an interrupted previous run never breaks this
    // suite's own cleanup, regardless of which phase added which table.
    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { startsWith: '+96650000' } } });
    await prisma.role.deleteMany({});
    await prisma.permission.deleteMany({});

    const branchesPerm = await prisma.permission.create({
      data: { code: 'branches.manage', label: 'إدارة الفروع' },
    });
    const usersPerm = await prisma.permission.create({ data: { code: 'users.manage', label: 'إدارة المستخدمين' } });
    const adminRole = await prisma.role.create({ data: { name: 'Admin-Test' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: adminRole.id, permissionId: branchesPerm.id },
        { roleId: adminRole.id, permissionId: usersPerm.id },
      ],
    });
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({
      data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash },
    });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects login with a wrong password', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('logs in with correct credentials and returns access+refresh tokens', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    adminToken = res.body.accessToken;
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await request(app.getHttpServer()).get('/users');
    expect(res.status).toBe(401);
  });

  it('rejects a request body with a field not declared on the DTO', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'x', phone: '+966500000099', password: '12345678', isAdmin: true });
    expect(res.status).toBe(400);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'x', phone: '+966500000098', password: '123' });
    expect(res.status).toBe(400);
  });

  it('creates a branch as the admin (has branches.manage)', async () => {
    const res = await request(app.getHttpServer())
      .post('/locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'فرع الرياض', type: 'BRANCH', address: 'شارع الملك فهد' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('فرع الرياض');
  });

  it('creates a second branch and a cashier user with NO extra permissions', async () => {
    const res = await request(app.getHttpServer())
      .post('/locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'فرع جدة', type: 'BRANCH' });
    expect(res.status).toBe(201);

    const userRes = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'كاشير', phone: '+966500000002', password: 'CashierPass123' });
    expect(userRes.status).toBe(201);
    expect(userRes.body.roles).toEqual([]);
  });

  it('blocks a permission-less user from creating a branch (403)', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: '+966500000002', password: 'CashierPass123' });
    const cashierToken = loginRes.body.accessToken;

    const res = await request(app.getHttpServer())
      .post('/locations')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ name: 'فرع غير مصرح', type: 'BRANCH' });
    expect(res.status).toBe(403);
  });

  it('still lets that same permission-less user LIST branches (reading needs no permission)', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: '+966500000002', password: 'CashierPass123' });
    const cashierToken = loginRes.body.accessToken;

    const res = await request(app.getHttpServer()).get('/locations').set('Authorization', `Bearer ${cashierToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('filters the location list to a user\'s scoped location(s) only', async () => {
    const locations = await prisma.location.findMany();
    const riyadh = locations.find((l) => l.name === 'فرع الرياض')!;
    const jeddah = locations.find((l) => l.name === 'فرع جدة')!;

    const createRes = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'مدير الرياض', phone: '+966500000003', password: 'RiyadhMgr123', locationIds: [riyadh.id] });
    expect(createRes.status).toBe(201);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: '+966500000003', password: 'RiyadhMgr123' });
    const scopedToken = loginRes.body.accessToken;

    const listRes = await request(app.getHttpServer()).get('/locations').set('Authorization', `Bearer ${scopedToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.map((l: any) => l.id)).toEqual([riyadh.id]);

    const getJeddahRes = await request(app.getHttpServer())
      .get(`/locations/${jeddah.id}`)
      .set('Authorization', `Bearer ${scopedToken}`);
    expect(getJeddahRes.status).toBe(404);
  });

  it('rejects creating a user with an already-registered phone', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'dup', phone: ADMIN_PHONE, password: '12345678' });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown location id', async () => {
    const res = await request(app.getHttpServer())
      .get('/locations/does-not-exist')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('refreshes an access token from a valid refresh token', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    const { refreshToken } = loginRes.body;

    const res = await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects a refresh token used as a bearer access token', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    const { refreshToken } = loginRes.body;

    const res = await request(app.getHttpServer()).get('/locations').set('Authorization', `Bearer ${refreshToken}`);
    expect(res.status).toBe(401);
  });

  it('never returns passwordHash on any user-shaped response', async () => {
    const res = await request(app.getHttpServer()).get('/users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const user of res.body) {
      expect(user.passwordHash).toBeUndefined();
    }
  });
});
