import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { XMLParser } from 'fast-xml-parser';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// pos.backdate_shift: open a shift dated on a real past business day (system
// was down, nobody opened a shift that day, etc.) to record the sales that
// were missed, then close it -- without that deliberately-stale shift
// blocking the rest of the location's business in the meantime. Two things
// under test: (1) the permission gate + future-date guard on open(), and
// (2) that OrdersService.create()'s "no unsettled prior day" block excludes
// ONLY the exact shift an order targets, not the whole location.
describe('Backdated shift open (pos.backdate_shift) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let backdateToken: string;
  let plainToken: string;
  let menuItemId: string;
  let locationId: string;

  const BACKDATE_PHONE = '+966500000320';
  const PLAIN_PHONE = '+966500000321';
  const PASSWORD = 'BackdateShift123';
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
    await prisma.user.deleteMany({ where: { phone: { in: [BACKDATE_PHONE, PLAIN_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['Backdate-Test-Role', 'Plain-Test-Role'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['pos.manage_shift', 'pos.backdate_shift'] } } });

    const manageShiftPerm = await prisma.permission.create({ data: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' } });
    const backdatePerm = await prisma.permission.create({ data: { code: 'pos.backdate_shift', label: 'فتح وردية بتاريخ سابق' } });

    const backdateRole = await prisma.role.create({ data: { name: 'Backdate-Test-Role' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: backdateRole.id, permissionId: manageShiftPerm.id },
        { roleId: backdateRole.id, permissionId: backdatePerm.id },
      ],
    });
    const plainRole = await prisma.role.create({ data: { name: 'Plain-Test-Role' } });
    await prisma.rolePermission.create({ data: { roleId: plainRole.id, permissionId: manageShiftPerm.id } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const backdateUser = await prisma.user.create({ data: { name: BACKDATE_PHONE, phone: BACKDATE_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: backdateUser.id, roleId: backdateRole.id } });
    const plainUser = await prisma.user.create({ data: { name: PLAIN_PHONE, phone: PLAIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: plainUser.id, roleId: plainRole.id } });

    const backdateLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: BACKDATE_PHONE, password: PASSWORD });
    backdateToken = backdateLogin.body.accessToken;
    const plainLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: PLAIN_PHONE, password: PASSWORD });
    plainToken = plainLogin.body.accessToken;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار وردية متأخرة', category: 'اختبار', price: 25 } });
    menuItemId = menuItem.id;
    locationId = (await prisma.location.create({ data: { name: 'فرع اختبار وردية متأخرة', type: 'BRANCH' } })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a backdated open() without pos.backdate_shift', async () => {
    const yesterday = new Date(startOfUtcDay(new Date()).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await request(app.getHttpServer())
      .post('/shifts')
      .set(auth(plainToken))
      .send({ locationId, openingFloat: 100, businessDate: yesterday });
    expect(res.status).toBe(403);
  });

  it('rejects a future businessDate even with the permission', async () => {
    const tomorrow = new Date(startOfUtcDay(new Date()).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await request(app.getHttpServer())
      .post('/shifts')
      .set(auth(backdateToken))
      .send({ locationId, openingFloat: 100, businessDate: tomorrow });
    expect(res.status).toBe(400);
  });

  it('opens a real past-dated shift, lets orders land on it, but still blocks OTHER shifts at the location', async () => {
    const threeDaysAgo = startOfUtcDay(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const businessDate = threeDaysAgo.toISOString().slice(0, 10);

    const openRes = await request(app.getHttpServer())
      .post('/shifts')
      .set(auth(backdateToken))
      .send({ locationId, openingFloat: 150, businessDate });
    expect(openRes.status).toBe(201);
    const backdatedShiftId = openRes.body.id;
    expect(new Date(openRes.body.businessDate).getTime()).toBe(threeDaysAgo.getTime());

    // It shows up as a stale open shift...
    const status = await request(app.getHttpServer()).get(`/shifts/settlement-status?locationId=${locationId}`).set(auth(backdateToken));
    expect(status.body.openStaleShifts.map((s: { id: string }) => s.id)).toContain(backdatedShiftId);

    // ...yet an order posted directly to IT succeeds -- that's the retroactive entry this shift exists for.
    const backfilledOrder = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(backdateToken))
      .send({ locationId, shiftId: backdatedShiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    expect(backfilledOrder.status).toBe(201);
    expect(new Date(backfilledOrder.body.businessDate).getTime()).toBe(threeDaysAgo.getTime());
    // Settle it -- close() below refuses a shift with any unpaid order.
    await request(app.getHttpServer())
      .post(`/orders/${backfilledOrder.body.id}/pay`)
      .set(auth(backdateToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(backfilledOrder.body.grandTotal) }] });

    // A separate, freshly-opened shift at the SAME location is still blocked
    // while the backdated one remains open -- only its own shift is exempt.
    const freshShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(backdateToken)).send({ locationId, openingFloat: 100 });
    const blockedFresh = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(backdateToken))
      .send({ locationId, shiftId: freshShiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(blockedFresh.status).toBe(400);
    expect(blockedFresh.body.message).toContain('ورديات مفتوحة');

    // Closing the backdated shift through the ordinary close() endpoint works fine.
    const closeRes = await request(app.getHttpServer())
      .post(`/shifts/${backdatedShiftId}/close`)
      .set(auth(backdateToken))
      .send({ closingCounted: 200 });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.closedAt).toBeTruthy();
  });

  // pay()'s optional paidAt: for sales genuinely migrated from another
  // system that never had a ZATCA invoice issued for them, the real
  // transaction date has to survive as the invoice's issue date -- unlike
  // the routine backdated-shift case above, where paidAt intentionally stays
  // "now" (confirmed with the user) since ZATCA already sees those as newly
  // issued. Own location with a vatNumber so ZATCA actually generates here.
  it('pay() accepts an explicit paidAt (pos.backdate_shift only) that becomes the ZATCA invoice issue date', async () => {
    const vatLocationId = (
      await prisma.location.create({ data: { name: 'فرع اختبار تاريخ الدفع الصريح', type: 'BRANCH', vatNumber: '399999999900011' } })
    ).id;
    const threeDaysAgo = startOfUtcDay(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const businessDate = threeDaysAgo.toISOString().slice(0, 10);
    const explicitPaidAt = new Date(threeDaysAgo.getTime() + 14 * 60 * 60 * 1000).toISOString(); // same day, 14:00 UTC

    const openRes = await request(app.getHttpServer())
      .post('/shifts')
      .set(auth(backdateToken))
      .send({ locationId: vatLocationId, openingFloat: 100, businessDate });
    const shiftId = openRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(backdateToken))
      .send({ locationId: vatLocationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const orderId = orderRes.body.id;

    // Without pos.backdate_shift, an explicit paidAt is rejected outright.
    const noPerm = await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(plainToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }], paidAt: explicitPaidAt });
    expect(noPerm.status).toBe(403);

    // A future paidAt is rejected even with the permission.
    const future = await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(backdateToken))
      .send({
        payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }],
        paidAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(future.status).toBe(400);

    // A paidAt that doesn't fall on the order's own businessDate is rejected too.
    const mismatched = await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(backdateToken))
      .send({
        payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }],
        paidAt: new Date(threeDaysAgo.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(mismatched.status).toBe(400);

    // Matching the order's businessDate succeeds, and the stored paidAt is
    // exactly the timestamp given -- not "now".
    const paid = await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(backdateToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }], paidAt: explicitPaidAt });
    expect(paid.status).toBe(200);
    expect(new Date(paid.body.paidAt).getTime()).toBe(new Date(explicitPaidAt).getTime());
    expect(paid.body.zatcaSyncStatus).toBe('GENERATED');

    const parser = new XMLParser();
    const parsed = parser.parse(paid.body.zatcaXml);
    expect(parsed.Invoice['cbc:IssueDate']).toBe(explicitPaidAt.slice(0, 10));
  });
});
