import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A new sales invoice must not land on top of an unsettled prior day: (1) a
// shift opened before today that's still open (till not reconciled), or (2)
// a calendar day whose shifts are all closed but nobody hit "إنهاء اليوم"
// for it. Both cases are simulated by backdating Shift.openedAt AND
// businessDate directly via Prisma (no clock to travel, and OpenShiftDto
// has no way to set either) -- businessDate is what ShiftsService actually
// buckets by (fixed at real open() time), so a backdate that only touched
// openedAt would no longer register as a prior-day shift at all.
describe('Unsettled prior day/shift blocks new order creation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let menuItemId: string;

  const PHONE = '+966500000310';
  const PASSWORD = 'UnsettledDay123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: PHONE } });
    await prisma.role.deleteMany({ where: { name: 'UnsettledDay-Test' } });
    await prisma.permission.deleteMany({ where: { code: 'pos.manage_shift' } });

    const shiftPerm = await prisma.permission.create({ data: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' } });
    const role = await prisma.role.create({ data: { name: 'UnsettledDay-Test' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: shiftPerm.id } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار إنهاء اليوم', category: 'اختبار', price: 40 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('settlement-status is clean and orders succeed with only a fresh, open-today shift', async () => {
    const locationId = (await prisma.location.create({ data: { name: 'فرع اختبار 1 - إنهاء اليوم', type: 'BRANCH' } })).id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const status = await request(app.getHttpServer()).get(`/shifts/settlement-status?locationId=${locationId}`).set(auth(token));
    expect(status.status).toBe(200);
    expect(status.body.openStaleShifts).toHaveLength(0);
    expect(status.body.unclosedDays).toHaveLength(0);

    const order = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(order.status).toBe(201);
  });

  it('a shift left open from a prior day blocks new order creation and shows in settlement-status', async () => {
    const locationId = (await prisma.location.create({ data: { name: 'فرع اختبار 2 - إنهاء اليوم', type: 'BRANCH' } })).id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const staleShiftId = shiftRes.body.id;
    const yesterday = new Date(startOfUtcDay(new Date()).getTime() - 24 * 60 * 60 * 1000 + 3600_000);
    await prisma.shift.update({ where: { id: staleShiftId }, data: { openedAt: yesterday, businessDate: startOfUtcDay(yesterday) } });

    const status = await request(app.getHttpServer()).get(`/shifts/settlement-status?locationId=${locationId}`).set(auth(token));
    expect(status.body.openStaleShifts).toHaveLength(1);
    expect(status.body.openStaleShifts[0].id).toBe(staleShiftId);

    const blocked = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: staleShiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('ورديات مفتوحة');

    // A fresh shift opened today, on the SAME location, is blocked too --
    // the gate is location-wide, not per-shift.
    const freshShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const blockedFresh = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: freshShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(blockedFresh.status).toBe(400);

    // Closing the stale shift clears the "open shift" block, but yesterday
    // now falls straight into the OTHER block (fully closed, never ended)
    // -- both gates are real, so ending that day too is required before a
    // new order goes through.
    await request(app.getHttpServer()).post(`/shifts/${staleShiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
    const stillBlocked = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: freshShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(stillBlocked.status).toBe(400);
    expect(stillBlocked.body.message).toContain('اليوم');

    const businessDate = yesterday.toISOString().slice(0, 10);
    await request(app.getHttpServer()).post('/shifts/day-close').set(auth(token)).send({ locationId, businessDate });

    const unblocked = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: freshShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(unblocked.status).toBe(201);
  });

  it('a fully-closed prior day with no DayClose rollup blocks new orders until "إنهاء اليوم" runs', async () => {
    const locationId = (await prisma.location.create({ data: { name: 'فرع اختبار 3 - إنهاء اليوم', type: 'BRANCH' } })).id;
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const priorShiftId = shiftRes.body.id;
    const yesterday = new Date(startOfUtcDay(new Date()).getTime() - 24 * 60 * 60 * 1000 + 3600_000);
    await prisma.shift.update({ where: { id: priorShiftId }, data: { openedAt: yesterday, businessDate: startOfUtcDay(yesterday) } });
    // Close it (reconciled), but do NOT run day-close -- this is exactly
    // the "yesterday's till is fine, but nobody ended the day" gap.
    await request(app.getHttpServer()).post(`/shifts/${priorShiftId}/close`).set(auth(token)).send({ closingCounted: 100 });

    const status = await request(app.getHttpServer()).get(`/shifts/settlement-status?locationId=${locationId}`).set(auth(token));
    expect(status.body.openStaleShifts).toHaveLength(0);
    expect(status.body.unclosedDays).toHaveLength(1);

    const todayShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const blocked = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: todayShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('اليوم');

    const businessDate = yesterday.toISOString().slice(0, 10);
    const closeDay = await request(app.getHttpServer()).post('/shifts/day-close').set(auth(token)).send({ locationId, businessDate });
    expect(closeDay.status).toBe(200);

    const statusAfter = await request(app.getHttpServer()).get(`/shifts/settlement-status?locationId=${locationId}`).set(auth(token));
    expect(statusAfter.body.unclosedDays).toHaveLength(0);

    const unblocked = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId: todayShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(unblocked.status).toBe(201);
  });

  it('settlement-status is scoped per-location -- another location with unsettled shifts is unaffected', async () => {
    const cleanLocationId = (await prisma.location.create({ data: { name: 'فرع اختبار 4 - نظيف', type: 'BRANCH' } })).id;
    const dirtyLocationId = (await prisma.location.create({ data: { name: 'فرع اختبار 5 - متعثر', type: 'BRANCH' } })).id;

    const dirtyShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId: dirtyLocationId, openingFloat: 100 });
    const yesterday = new Date(startOfUtcDay(new Date()).getTime() - 24 * 60 * 60 * 1000 + 3600_000);
    await prisma.shift.update({ where: { id: dirtyShiftRes.body.id }, data: { openedAt: yesterday, businessDate: startOfUtcDay(yesterday) } });

    const cleanShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId: cleanLocationId, openingFloat: 100 });
    const order = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId: cleanLocationId, shiftId: cleanShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(order.status).toBe(201);
  });
});
