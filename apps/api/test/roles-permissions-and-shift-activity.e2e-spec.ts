import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Roles/Permissions: previously nothing existed beyond the seeded roles --
// this is the first CRUD surface for Role + its permission assignment
// (RolePermission), gated behind users.manage (the same code the seed data
// already labels "إدارة المستخدمين والأدوار"). Permissions themselves are a
// fixed, read-only catalog (each code gates a real route in code already).
//
// Shift activity log: a chronological timeline synthesized from existing
// timestamped rows (Shift open/close, Order created/paid, OrderActivityLog
// entries) rather than a new dedicated log table -- covers every event type
// this session added logging for (HELD already existed; VOIDED/RETURNED are
// new).
describe('Roles/Permissions + shift activity log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;

  const ADMIN_PHONE = '+966500000180';
  const NOPERM_PHONE = '+966500000181';
  const PASSWORD = 'RolesPermTest123';
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
    await prisma.role.deleteMany({ where: { name: 'RolesTest-Admin' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['users.manage', 'pos.void_order', 'pos.return_order', 'pos.manage_shift'] } } });

    const perms = await Promise.all(
      [
        { code: 'users.manage', label: 'إدارة المستخدمين والأدوار' },
        { code: 'pos.void_order', label: 'إلغاء طلب من الكاشير' },
        { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' },
        { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
      ].map((p) => prisma.permission.create({ data: p })),
    );
    const adminRole = await prisma.role.create({ data: { name: 'RolesTest-Admin' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: adminRole.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const adminUser = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });
    await prisma.user.create({ data: { name: 'NoPerm', phone: NOPERM_PHONE, passwordHash } });

    const adminLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = adminLogin.body.accessToken;
    const noPermLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    noPermToken = noPermLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Permissions catalog', () => {
    it('lists the fixed permission catalog for a user with users.manage', async () => {
      const res = await request(app.getHttpServer()).get('/permissions').set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.some((p: { code: string }) => p.code === 'users.manage')).toBe(true);
      expect(res.body.some((p: { code: string }) => p.code === 'pos.void_order')).toBe(true);
    });

    it('blocks a user without users.manage (403)', async () => {
      const res = await request(app.getHttpServer()).get('/permissions').set(auth(noPermToken));
      expect(res.status).toBe(403);
    });
  });

  describe('Roles CRUD', () => {
    it('blocks creating a role without users.manage (403)', async () => {
      const res = await request(app.getHttpServer())
        .post('/roles')
        .set(auth(noPermToken))
        .send({ name: 'دور بلا صلاحية', permissionCodes: ['pos.void_order'] });
      expect(res.status).toBe(403);
    });

    it('rejects an unknown permission code (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/roles')
        .set(auth(adminToken))
        .send({ name: 'دور برمز وهمي', permissionCodes: ['no.such.permission'] });
      expect(res.status).toBe(400);
    });

    it('creates, lists, updates (replacing permissions), and deletes a role', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/roles')
        .set(auth(adminToken))
        .send({ name: 'مشرف مبيعات -- اختبار', description: 'وصف تجريبي', permissionCodes: ['pos.void_order'] });
      expect(createRes.status).toBe(201);
      expect(createRes.body.permissions).toHaveLength(1);
      expect(createRes.body.permissions[0].code).toBe('pos.void_order');
      expect(createRes.body.userCount).toBe(0);
      const roleId = createRes.body.id;

      const listRes = await request(app.getHttpServer()).get('/roles').set(auth(adminToken));
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((r: { id: string }) => r.id === roleId)).toBe(true);

      // Duplicate name rejected.
      const dupRes = await request(app.getHttpServer())
        .post('/roles')
        .set(auth(adminToken))
        .send({ name: 'مشرف مبيعات -- اختبار', permissionCodes: [] });
      expect(dupRes.status).toBe(409);

      // Replace permission set entirely (not merge).
      const updateRes = await request(app.getHttpServer())
        .patch(`/roles/${roleId}`)
        .set(auth(adminToken))
        .send({ permissionCodes: ['pos.return_order'] });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.permissions).toHaveLength(1);
      expect(updateRes.body.permissions[0].code).toBe('pos.return_order');

      // Assign to a user -- deletion should now be blocked.
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const assignedUser = await prisma.user.create({ data: { name: 'مستخدم مُسند', phone: '+966500000182', passwordHash } });
      await request(app.getHttpServer()).patch(`/users/${assignedUser.id}`).set(auth(adminToken)).send({ roleIds: [roleId] });

      const blockedDelete = await request(app.getHttpServer()).delete(`/roles/${roleId}`).set(auth(adminToken));
      expect(blockedDelete.status).toBe(400);

      // Unassign, then deletion succeeds.
      await request(app.getHttpServer()).patch(`/users/${assignedUser.id}`).set(auth(adminToken)).send({ roleIds: [] });
      const okDelete = await request(app.getHttpServer()).delete(`/roles/${roleId}`).set(auth(adminToken));
      expect(okDelete.status).toBe(200);

      const getDeleted = await request(app.getHttpServer()).get(`/roles/${roleId}`).set(auth(adminToken));
      expect(getDeleted.status).toBe(404);
    });
  });

  describe('User password reset via PATCH /users/:id', () => {
    it('changes the password and the old one stops working', async () => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: 'صاحب كلمة مرور', phone: '+966500000183', passwordHash } });

      const newPassword = 'BrandNewPass456';
      const updateRes = await request(app.getHttpServer())
        .patch(`/users/${user.id}`)
        .set(auth(adminToken))
        .send({ password: newPassword });
      expect(updateRes.status).toBe(200);

      const oldLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: '+966500000183', password: PASSWORD });
      expect(oldLogin.status).toBe(401);

      const newLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: '+966500000183', password: newPassword });
      expect(newLogin.status).toBe(201);
    });
  });

  describe('Shift activity log + date-range shift listing', () => {
    it('builds a chronological timeline covering open/created/paid/held/voided/returned/close', async () => {
      const location = await prisma.location.create({ data: { name: 'فرع اختبار سجل الحركة', type: 'BRANCH' } });
      const item = await prisma.menuItem.create({ data: { name: 'صنف -- سجل الحركة', category: 'رئيسي', price: 20 } });

      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
      const shiftId = shiftRes.body.id;

      // Order 1: paid.
      const order1 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 1 }] });
      await request(app.getHttpServer()).post(`/orders/${order1.body.id}/pay`).set(auth(adminToken)).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order1.body.grandTotal) }] });

      // Order 2: held.
      const order2 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({ locationId: location.id, shiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: item.id, quantity: 1 }] });
      await request(app.getHttpServer()).post(`/orders/${order2.body.id}/hold`).set(auth(adminToken)).send({ note: 'العميل سيعود' });
      // Pay it off so the shift can close.
      await request(app.getHttpServer()).post(`/orders/${order2.body.id}/pay`).set(auth(adminToken)).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order2.body.grandTotal) }] });

      // Order 3: voided.
      const order3 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 1 }] });
      await request(app.getHttpServer()).post(`/orders/${order3.body.id}/void`).set(auth(adminToken));

      // Order 4: paid then returned.
      const order4 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 1 }] });
      await request(app.getHttpServer()).post(`/orders/${order4.body.id}/pay`).set(auth(adminToken)).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order4.body.grandTotal) }] });
      const order4Line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: order4.body.id } });
      // A return is only allowed once the kitchen has finished the line
      // (READY/SERVED) -- QUEUED -> PREPARING -> READY, two bumps.
      await request(app.getHttpServer()).post(`/kitchen/lines/${order4Line.id}/advance`).set(auth(adminToken));
      await request(app.getHttpServer()).post(`/kitchen/lines/${order4Line.id}/advance`).set(auth(adminToken));
      await request(app.getHttpServer())
        .post('/returns')
        .set(auth(adminToken))
        .send({ orderId: order4.body.id, reason: 'اختبار سجل الحركة', lines: [{ orderLineId: order4Line.id, quantity: 1 }] });

      await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(adminToken)).send({ closingCounted: 100 });

      const res = await request(app.getHttpServer()).get(`/shifts/${shiftId}/activity-log`).set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.shift.shiftNumber).toBeGreaterThanOrEqual(1);
      expect(res.body.shift.openedBy).toBe('Admin');
      expect(res.body.shift.closedBy).toBe('Admin');

      const types = res.body.events.map((e: { type: string }) => e.type);
      expect(types).toContain('SHIFT_OPENED');
      expect(types).toContain('SHIFT_CLOSED');
      expect(types.filter((t: string) => t === 'ORDER_CREATED')).toHaveLength(4);
      expect(types.filter((t: string) => t === 'ORDER_PAID')).toHaveLength(3); // order1, order2 (after hold), order4
      expect(types).toContain('ORDER_HELD');
      expect(types).toContain('ORDER_VOIDED');
      expect(types).toContain('ORDER_RETURNED');

      // Newest-first ordering: SHIFT_CLOSED (last thing that happened) comes
      // before SHIFT_OPENED (first thing that happened) in the list.
      const closedIdx = types.indexOf('SHIFT_CLOSED');
      const openedIdx = types.indexOf('SHIFT_OPENED');
      expect(closedIdx).toBeLessThan(openedIdx);

      const heldEvent = res.body.events.find((e: { type: string }) => e.type === 'ORDER_HELD');
      expect(heldEvent.note).toBe('العميل سيعود');
      expect(heldEvent.by).toBe('Admin');
    });

    it('filters the shift list by date range', async () => {
      const location = await prisma.location.create({ data: { name: 'فرع اختبار فلترة التاريخ', type: 'BRANCH' } });
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 50 });

      const today = new Date().toISOString().slice(0, 10);
      const inRange = await request(app.getHttpServer()).get(`/shifts?locationId=${location.id}&from=${today}&to=${today}`).set(auth(adminToken));
      expect(inRange.status).toBe(200);
      expect(inRange.body.some((s: { id: string }) => s.id === shiftRes.body.id)).toBe(true);

      const outOfRange = await request(app.getHttpServer()).get(`/shifts?locationId=${location.id}&from=2099-01-01&to=2099-01-02`).set(auth(adminToken));
      expect(outOfRange.status).toBe(200);
      expect(outOfRange.body.some((s: { id: string }) => s.id === shiftRes.body.id)).toBe(false);
    });
  });
});
