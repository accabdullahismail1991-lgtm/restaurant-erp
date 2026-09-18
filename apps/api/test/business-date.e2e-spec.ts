import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { computeBusinessDate } from '../src/common/business-date.util';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A shift/order's "business date" is which day it counts toward for
// invoice numbering and end-of-day settlement -- distinct from a plain
// calendar day. A shift opened at 5am and still running at 2:30am the
// NEXT calendar day keeps every one of its orders on the SAME business
// date, per the user's own example. computeBusinessDate() (common/
// business-date.util.ts) is a pure function -- exercised directly here
// with synthetic Date objects, since manipulating real wall-clock time in
// an integration test would be flaky/impossible to control.
describe('computeBusinessDate (pure function)', () => {
  it('a normal daytime moment (after the cutoff) stays on its own calendar day', () => {
    const now = new Date('2026-09-19T10:00:00Z');
    const result = computeBusinessDate(now, 4);
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-19');
  });

  it("the user's own scenario: a shift opened 5am 19-09 and an order placed 2:30am 20-09 both land on 19-09 (cutoff hour 5)", () => {
    const orderTime = new Date('2026-09-20T02:30:00Z');
    const result = computeBusinessDate(orderTime, 5);
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-19');
  });

  it('a moment exactly AT the cutoff hour does not roll back', () => {
    const now = new Date('2026-09-20T05:00:00Z');
    const result = computeBusinessDate(now, 5);
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('a moment one minute before the cutoff hour still rolls back', () => {
    const now = new Date('2026-09-20T04:59:00Z');
    const result = computeBusinessDate(now, 5);
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-19');
  });

  it('fiscal year-end exception: the rolled-back date landing exactly on the configured fiscal year-end suspends the roll-back', () => {
    // New Year's Day, 2am, cutoff 4 -- naive answer would be Dec 31 (the
    // configured fiscal year-end), so the exception applies and the real
    // Jan 1 is used instead, never folding the new year's first hours
    // into the old year's last business day.
    const now = new Date('2027-01-01T02:00:00Z');
    const result = computeBusinessDate(now, 4, 12, 31);
    expect(result.toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  it('fiscal year-end exception does NOT apply when the rolled-back date is a different day', () => {
    const now = new Date('2026-09-20T02:30:00Z');
    const result = computeBusinessDate(now, 5, 12, 31); // fiscal year-end is Dec 31, unrelated to Sep 19
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-19'); // still rolls back normally
  });

  it('null fiscalYearEndMonth/Day (the default) never triggers the exception', () => {
    const now = new Date('2027-01-01T02:00:00Z');
    const result = computeBusinessDate(now, 4, null, null);
    expect(result.toISOString().slice(0, 10)).toBe('2026-12-31'); // rolls back normally, no exception configured
  });
});

describe('Business date wired into shifts/orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let menuItemId: string;

  const PHONE = '+966500000200';
  const PASSWORD = 'BusinessDateTest123';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: PHONE } } });
    await prisma.user.deleteMany({ where: { phone: PHONE } });
    // A prior run of this suite may have left the role (and its
    // RolePermission rows) behind -- delete the child rows first so the
    // role delete below doesn't hit RolePermission_roleId_fkey.
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'BusinessDate-Test-Role' } } });
    await prisma.role.deleteMany({ where: { name: 'BusinessDate-Test-Role' } });

    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const branchesManagePerm = await prisma.permission.upsert({
      where: { code: 'branches.manage' },
      update: {},
      create: { code: 'branches.manage', label: 'إدارة الفروع' },
    });
    const role = await prisma.role.create({ data: { name: 'BusinessDate-Test-Role' } });
    await prisma.rolePermission.createMany({ data: [shiftPerm, branchesManagePerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: 'Business Date Tester', phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار تاريخ العمل', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار تاريخ العمل', category: 'اختبار', price: 20 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("a freshly-opened shift's businessDate matches computeBusinessDate() for right now", async () => {
    const location = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const expected = computeBusinessDate(new Date(), location.autoCloseCutoffHour, location.fiscalYearEndMonth, location.fiscalYearEndDay);

    const res = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    expect(res.status).toBe(201);
    expect(res.body.businessDate).toBeTruthy();
    expect(new Date(res.body.businessDate).toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));

    await request(app.getHttpServer()).post(`/shifts/${res.body.id}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it("an order created on a shift copies the shift's own businessDate", async () => {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.businessDate).toBeTruthy();
    expect(orderRes.body.businessDate).toBe(shiftRes.body.businessDate);

    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    expect(payRes.status).toBe(200);
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: Number(orderRes.body.grandTotal) + 100 });
  });

  it('two orders on the same shift share the same dailySequence bucket (both count toward the same business date)', async () => {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });

    expect(order1.body.businessDate).toBe(order2.body.businessDate);
    expect(order2.body.dailySequence).toBe(order1.body.dailySequence + 1);

    await request(app.getHttpServer()).post(`/orders/${order1.body.id}/void`).set(auth(token));
    await request(app.getHttpServer()).post(`/orders/${order2.body.id}/void`).set(auth(token));
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it('PATCH /locations/:id accepts a paired fiscal year-end and rejects a lone month or an invalid day-for-month', async () => {
    const ok = await request(app.getHttpServer()).patch(`/locations/${locationId}`).set(auth(token)).send({ fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
    expect(ok.status).toBe(200);
    expect(ok.body.fiscalYearEndMonth).toBe(12);
    expect(ok.body.fiscalYearEndDay).toBe(31);

    const lonelyMonth = await request(app.getHttpServer()).patch(`/locations/${locationId}`).set(auth(token)).send({ fiscalYearEndMonth: null });
    expect(lonelyMonth.status).toBe(400);

    const invalidDay = await request(app.getHttpServer()).patch(`/locations/${locationId}`).set(auth(token)).send({ fiscalYearEndMonth: 4, fiscalYearEndDay: 31 });
    expect(invalidDay.status).toBe(400);

    const cleared = await request(app.getHttpServer())
      .patch(`/locations/${locationId}`)
      .set(auth(token))
      .send({ fiscalYearEndMonth: null, fiscalYearEndDay: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.fiscalYearEndMonth).toBeNull();
    expect(cleared.body.fiscalYearEndDay).toBeNull();
  });
});
