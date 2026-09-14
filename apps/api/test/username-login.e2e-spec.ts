import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// User.username: an optional alternate login identifier so a cashier can
// log in with a memorable username instead of a phone number. The wire
// shape is unchanged -- POST /auth/login still takes a "phone" field, it
// just now also accepts a username value in that same field -- so this
// suite proves BOTH that username login genuinely works AND that nothing
// about existing phone-only login broke.
describe('User.username: login via username instead of phone (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const ADMIN_PHONE = '+966500000090';
  const ADMIN_PASSWORD = 'UsernameLoginTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: { startsWith: '+96650000009' } } } });
    await prisma.user.deleteMany({ where: { phone: { startsWith: '+96650000009' } } });
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'Username-Login-Test-Admin' } } });
    await prisma.role.deleteMany({ where: { name: 'Username-Login-Test-Admin' } });

    const usersPerm = await prisma.permission.upsert({
      where: { code: 'users.manage' },
      update: {},
      create: { code: 'users.manage', label: 'إدارة المستخدمين' },
    });
    const role = await prisma.role.create({ data: { name: 'Username-Login-Test-Admin' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: usersPerm.id } });

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Username Login Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('still logs in by phone with no username set (existing behavior unaffected)', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('creates a user with a username via POST /users', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'كاشير محمد', phone: '+966500000091', username: 'cashier.mohammed', password: 'CashierPass123' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('cashier.mohammed');
  });

  it('logs in using the username instead of the phone number', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone: 'cashier.mohammed', password: 'CashierPass123' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('still logs that same user in with their actual phone number too', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone: '+966500000091', password: 'CashierPass123' });
    expect(res.status).toBe(201);
  });

  it('rejects creating a second user whose username collides with an existing phone number', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'تعارض', phone: '+966500000092', username: ADMIN_PHONE, password: 'ConflictPass123' });
    expect(res.status).toBe(409);
  });

  it('rejects creating a second user whose username collides with an existing username', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'تعارض٢', phone: '+966500000093', username: 'cashier.mohammed', password: 'ConflictPass123' });
    expect(res.status).toBe(409);
  });

  it('lets an admin set a username on an existing user via PATCH /users/:id', async () => {
    const created = await request(app.getHttpServer())
      .post('/users')
      .set(auth(adminToken))
      .send({ name: 'كاشير سارة', phone: '+966500000094', password: 'CashierPass123' });
    expect(created.body.username).toBeNull();

    const patched = await request(app.getHttpServer())
      .patch(`/users/${created.body.id}`)
      .set(auth(adminToken))
      .send({ username: 'cashier.sara' });
    expect(patched.status).toBe(200);
    expect(patched.body.username).toBe('cashier.sara');

    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: 'cashier.sara', password: 'CashierPass123' });
    expect(loginRes.status).toBe(201);
  });

  it('rejects an unknown username the same way as an unknown phone (401, no distinguishing detail)', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone: 'no.such.user', password: 'whatever12345' });
    expect(res.status).toBe(401);
  });
});
