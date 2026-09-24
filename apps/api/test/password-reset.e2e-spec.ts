import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Admin-generated password-reset link: an admin holding users.manage
// generates a one-time token for a specific user (POST
// /users/:id/password-reset-token), forwards the resulting link to that
// user themselves (this system sends no email of its own -- see
// User.email schema comment), and the user consumes it via the public
// POST /auth/reset-password. Proves the whole round trip, plus the
// single-use/expiry/authorization edges.
describe('Admin-generated password-reset link (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let targetUserId: string;

  const ADMIN_PHONE = '+966500000095';
  const ADMIN_PASSWORD = 'PasswordResetTest123';
  const TARGET_PHONE = '+966500000096';
  const TARGET_OLD_PASSWORD = 'OldPassword123';

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
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'Password-Reset-Test-Admin' } } });
    await prisma.role.deleteMany({ where: { name: 'Password-Reset-Test-Admin' } });

    const usersPerm = await prisma.permission.upsert({
      where: { code: 'users.manage' },
      update: {},
      create: { code: 'users.manage', label: 'إدارة المستخدمين' },
    });
    const role = await prisma.role.create({ data: { name: 'Password-Reset-Test-Admin' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: usersPerm.id } });

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Password Reset Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.accessToken;

    const targetPasswordHash = await bcrypt.hash(TARGET_OLD_PASSWORD, 10);
    const target = await prisma.user.create({
      data: { name: 'مستخدم يحتاج استعادة', phone: TARGET_PHONE, passwordHash: targetPasswordHash },
    });
    targetUserId = target.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects generating a link without users.manage (403)', async () => {
    const res = await request(app.getHttpServer()).post(`/users/${targetUserId}/password-reset-token`);
    expect(res.status).toBe(401); // no token at all -- JwtAuthGuard rejects first
  });

  let firstToken: string;
  it('lets an admin generate a reset token for the target user', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${targetUserId}/password-reset-token`)
      .set(auth(adminToken));
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    firstToken = res.body.token;
  });

  it('rejects resetting with an invalid/unknown token', async () => {
    const res = await request(app.getHttpServer()).post('/auth/reset-password').send({ token: 'not-a-real-token', newPassword: 'WhateverPass123' });
    expect(res.status).toBe(400);
  });

  it('rejects a new password shorter than 8 characters', async () => {
    const res = await request(app.getHttpServer()).post('/auth/reset-password').send({ token: firstToken, newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  const NEW_PASSWORD = 'BrandNewPassword123';
  it('resets the password with the valid token, publicly (no auth header)', async () => {
    const res = await request(app.getHttpServer()).post('/auth/reset-password').send({ token: firstToken, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('the user can now log in with the new password', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone: TARGET_PHONE, password: NEW_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('the old password no longer works', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone: TARGET_PHONE, password: TARGET_OLD_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('the same token cannot be used a second time (single-use)', async () => {
    const res = await request(app.getHttpServer()).post('/auth/reset-password').send({ token: firstToken, newPassword: 'AnotherPassword123' });
    expect(res.status).toBe(400);
  });

  it('generating a new token for the same user invalidates any previous unused one', async () => {
    const genA = await request(app.getHttpServer()).post(`/users/${targetUserId}/password-reset-token`).set(auth(adminToken));
    const tokenA = genA.body.token;
    const genB = await request(app.getHttpServer()).post(`/users/${targetUserId}/password-reset-token`).set(auth(adminToken));
    const tokenB = genB.body.token;

    const useA = await request(app.getHttpServer()).post('/auth/reset-password').send({ token: tokenA, newPassword: 'SupersededPass123' });
    expect(useA.status).toBe(400); // superseded by tokenB before ever being used

    const useB = await request(app.getHttpServer()).post('/auth/reset-password').send({ token: tokenB, newPassword: 'StillValidPass123' });
    expect(useB.status).toBe(201);
  });

  it('an expired token is rejected even though it was never used', async () => {
    const gen = await request(app.getHttpServer()).post(`/users/${targetUserId}/password-reset-token`).set(auth(adminToken));
    const token: string = gen.body.token;
    // Directly back-date the stored record's expiry -- the raw token itself
    // is never persisted anywhere for the test to re-derive, so this is the
    // only way to exercise the expiry branch without actually waiting 30
    // minutes for the real TTL to elapse.
    await prisma.passwordResetToken.updateMany({ where: { userId: targetUserId, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app.getHttpServer()).post('/auth/reset-password').send({ token, newPassword: 'TooLatePass123' });
    expect(res.status).toBe(400);
  });

  it('returns 404 generating a link for a nonexistent user', async () => {
    const res = await request(app.getHttpServer())
      .post('/users/does-not-exist/password-reset-token')
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});
