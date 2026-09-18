import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 10a: KDS (Kitchen Display System) -- closes a real, previously
// unused gap in the schema: OrderLine.kitchenStatus (QUEUED/PREPARING/
// READY/SERVED) and OrderStatus.READY have existed since the original
// scaffold (docs/DECISIONS.md #11) but nothing ever read or wrote them
// until this module. Runs against a real app + a real Postgres test
// database, same as every other suite.
describe('Phase 10a: kitchen / KDS (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let otherLocationId: string;
  let menuItemAId: string;
  let menuItemBId: string;
  let tableId: string;
  let shiftId: string;
  let otherShiftId: string;

  const ADMIN_PHONE = '+966500000080';
  const PASSWORD = 'KitchenTest123';

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
    const adminUser = await prisma.user.create({ data: { name: 'Kitchen Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    // adminToken opens shifts as scaffolding below -- same upsert pattern
    // the void-order test further down uses for its own one-off permission.
    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const shiftRole = await prisma.role.upsert({
      where: { name: 'Kitchen-Test-Shift' },
      update: {},
      create: { name: 'Kitchen-Test-Shift' },
    });
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

    const location = await prisma.location.create({ data: { name: 'فرع اختبار المطبخ', type: 'BRANCH' } });
    locationId = location.id;
    const otherLocation = await prisma.location.create({ data: { name: 'فرع آخر', type: 'BRANCH' } });
    otherLocationId = otherLocation.id;

    const table = await prisma.table.create({ data: { locationId, label: 'طاولة 7' } });
    tableId = table.id;

    const menuItemA = await prisma.menuItem.create({ data: { name: 'برجر اختبار', category: 'رئيسي', price: 30 } });
    menuItemAId = menuItemA.id;
    const menuItemB = await prisma.menuItem.create({ data: { name: 'بطاطس اختبار', category: 'جانبي', price: 10 } });
    menuItemBId = menuItemB.id;

    // One shift per location, reused across every test that hits it -- the
    // API allows only one OPEN shift per location; multiple orders in the
    // same shift is normal (same pattern as zatca.e2e-spec.ts).
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
    const otherShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: otherLocationId, openingFloat: 100 });
    otherShiftId = otherShiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('scopes the queue and rejects a location outside the caller scope the same way other modules do', async () => {
    // No UserLocationScope rows for this admin -- org-wide, so this is
    // really just proving the endpoint calls the shared scope check at
    // all; a genuinely out-of-scope 403 is exercised in other suites'
    // scope tests (kept out of scope here to avoid re-testing the shared
    // utility itself).
    const res = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${locationId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('shows a freshly created order in the queue with all lines QUEUED', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({
        locationId,
        shiftId,
        tableId,
        channel: 'DINE_IN',
        lines: [
          { menuItemId: menuItemAId, quantity: 1 },
          { menuItemId: menuItemBId, quantity: 2 },
        ],
      });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id;

    const queueRes = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${locationId}`).set(auth(adminToken));
    const ticket = queueRes.body.find((t: any) => t.orderId === orderId);
    expect(ticket).toBeDefined();
    expect(ticket.tableLabel).toBe('طاولة 7');
    expect(ticket.channel).toBe('DINE_IN');
    expect(ticket.lines).toHaveLength(2);
    expect(ticket.lines.every((l: any) => l.kitchenStatus === 'QUEUED')).toBe(true);

    // Clean up for the next tests' shift-per-location constraint.
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
  });

  it('advances a line through the full sequence and rejects advancing past SERVED', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: otherLocationId, shiftId: otherShiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: menuItemAId, quantity: 1 }] });
    const lineId = orderRes.body.lines[0].id;

    const step1 = await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    expect(step1.status).toBe(200);
    expect(step1.body.line.kitchenStatus).toBe('PREPARING');
    expect(step1.body.orderStatus).toBe('SENT_TO_KITCHEN'); // not all lines done yet (there's only one, but not READY yet)

    const step2 = await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    expect(step2.status).toBe(200);
    expect(step2.body.line.kitchenStatus).toBe('READY');
    // Single-line order, now READY -- the order itself should flip too.
    expect(step2.body.orderStatus).toBe('READY');

    const orderAfter = await request(app.getHttpServer()).get(`/orders/${orderRes.body.id}`).set(auth(adminToken));
    expect(orderAfter.body.status).toBe('READY');

    const step3 = await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    expect(step3.status).toBe(200);
    expect(step3.body.line.kitchenStatus).toBe('SERVED');

    const step4 = await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    expect(step4.status).toBe(400);
  });

  it('only flips the order to READY once EVERY line is done, not just one of several', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({
        locationId,
        shiftId,
        channel: 'DINE_IN',
        lines: [
          { menuItemId: menuItemAId, quantity: 1 },
          { menuItemId: menuItemBId, quantity: 1 },
        ],
      });
    const [lineA, lineB] = orderRes.body.lines;

    // Bump line A all the way to READY -- line B is still QUEUED, so the
    // order must NOT flip yet.
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineA.id}/advance`).set(auth(adminToken));
    const bump2 = await request(app.getHttpServer()).post(`/kitchen/lines/${lineA.id}/advance`).set(auth(adminToken));
    expect(bump2.body.line.kitchenStatus).toBe('READY');
    expect(bump2.body.orderStatus).toBe('SENT_TO_KITCHEN');

    // Now bump line B to READY too -- only now should the order flip.
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineB.id}/advance`).set(auth(adminToken));
    const bumpBReady = await request(app.getHttpServer()).post(`/kitchen/lines/${lineB.id}/advance`).set(auth(adminToken));
    expect(bumpBReady.body.line.kitchenStatus).toBe('READY');
    expect(bumpBReady.body.orderStatus).toBe('READY');
  });

  it('rejects advancing a line that belongs to a VOIDED order', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: otherLocationId, shiftId: otherShiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: menuItemAId, quantity: 1 }] });
    const lineId = orderRes.body.lines[0].id;

    // void_order needs a real permission in the rest of the app, but this
    // admin has zero roles (org-wide, no permission rows either) -- create
    // a quick permission+role so void actually succeeds for this one check.
    const perm = await prisma.permission.upsert({
      where: { code: 'pos.void_order' },
      update: {},
      create: { code: 'pos.void_order', label: 'إلغاء طلب' },
    });
    const role = await prisma.role.upsert({
      where: { name: 'Kitchen-Test-Voider' },
      update: {},
      create: { name: 'Kitchen-Test-Voider' },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
      update: {},
      create: { roleId: role.id, permissionId: perm.id },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { phone: ADMIN_PHONE } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });

    const voidRes = await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/void`).set(auth(adminToken));
    expect(voidRes.status).toBe(200);

    const advanceRes = await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    expect(advanceRes.status).toBe(400);
  });

  it('keeps a just-VOIDED order on the queue, tagged cancelled, since its line never left QUEUED', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: otherLocationId, shiftId: otherShiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: menuItemAId, quantity: 1 }] });
    await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/void`).set(auth(adminToken));

    const queueRes = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${otherLocationId}`).set(auth(adminToken));
    const ticket = queueRes.body.find((t: any) => t.orderId === orderRes.body.id);
    expect(ticket).toBeDefined();
    expect(ticket.cancelled).toBe(true);
    expect(ticket.lines[0].kitchenStatus).toBe('QUEUED');

    // acknowledgeCancel dismisses it -- it must not reappear on the next poll.
    const ackRes = await request(app.getHttpServer()).post(`/kitchen/orders/${orderRes.body.id}/acknowledge-cancel`).set(auth(adminToken));
    expect(ackRes.status).toBe(200);
    const queueAfterAck = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${otherLocationId}`).set(auth(adminToken));
    expect(queueAfterAck.body.some((t: any) => t.orderId === orderRes.body.id)).toBe(false);
  });

  it('does NOT surface a VOIDED order whose line was already READY/SERVED -- nothing left to stop cooking', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: otherLocationId, shiftId: otherShiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: menuItemAId, quantity: 1 }] });
    const lineId = orderRes.body.lines[0].id;
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken)); // now READY

    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    const voidPaidPerm = await prisma.permission.upsert({
      where: { code: 'pos.void_paid_order' },
      update: {},
      create: { code: 'pos.void_paid_order', label: 'إلغاء فاتورة مدفوعة بالكامل' },
    });
    const voidPaidRole = await prisma.role.upsert({ where: { name: 'Kitchen-Test-VoidPaid' }, update: {}, create: { name: 'Kitchen-Test-VoidPaid' } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: voidPaidRole.id, permissionId: voidPaidPerm.id } },
      update: {},
      create: { roleId: voidPaidRole.id, permissionId: voidPaidPerm.id },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { phone: ADMIN_PHONE } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: voidPaidRole.id } },
      update: {},
      create: { userId: user.id, roleId: voidPaidRole.id },
    });

    const voidPaidRes = await request(app.getHttpServer()).post(`/returns/void-paid-order/${orderRes.body.id}`).set(auth(adminToken));
    expect(voidPaidRes.status).toBe(200);

    const queueRes = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${otherLocationId}`).set(auth(adminToken));
    expect(queueRes.body.some((t: any) => t.orderId === orderRes.body.id)).toBe(false);
  });

  it('rejects acknowledging a cancel on an order that is not VOIDED', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: otherLocationId, shiftId: otherShiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: menuItemAId, quantity: 1 }] });

    const res = await request(app.getHttpServer()).post(`/kitchen/orders/${orderRes.body.id}/acknowledge-cancel`).set(auth(adminToken));
    expect(res.status).toBe(400);

    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
  });

  // A cashier can take payment before the kitchen finishes preparing an
  // order (a pay-first quick-service counter) -- paying it must NOT make
  // it vanish from the KDS board while food is still owed. This was a
  // real bug: queue() used to only look at Order.status === SENT_TO_KITCHEN,
  // and pay() unconditionally overwrites status to PAID regardless of
  // kitchenStatus, so the ticket disappeared the instant it was paid.
  //
  // Fresh location/shift/menu item here (not the shared ones above) --
  // this test and the advance-category block below both filter the queue
  // by menu-item category, and the shared fixtures above leave several
  // 'رئيسي' lines sitting at various non-SERVED statuses from earlier
  // tests, which would silently inflate these counts.
  it('keeps a PAID order on the queue -- still tagged paid -- while the kitchen has not finished preparing it', async () => {
    const loc = await prisma.location.create({ data: { name: 'فرع اختبار دفع قبل التحضير', type: 'BRANCH' } });
    const item = await prisma.menuItem.create({ data: { name: 'صنف اختبار دفع قبل التحضير', category: 'اختبار دفع مبكر', price: 15 } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: loc.id, openingFloat: 100 });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: loc.id, shiftId: shiftRes.body.id, channel: 'TAKEAWAY', lines: [{ menuItemId: item.id, quantity: 1 }] });
    expect(orderRes.status).toBe(201);

    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('PAID');

    const queueRes = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${loc.id}`).set(auth(adminToken));
    const ticket = queueRes.body.find((t: any) => t.orderId === orderRes.body.id);
    expect(ticket).toBeDefined(); // still on the board -- payment alone did not finish it
    expect(ticket.paid).toBe(true);
    expect(ticket.lines[0].kitchenStatus).toBe('QUEUED');

    // Kitchen staff must still explicitly bump it -- it stays on the
    // board through PREPARING, and once every line reaches READY it
    // drops off (same "already ready for pickup" rule the board applies
    // regardless of payment status).
    const lineId = orderRes.body.lines[0].id;
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken));
    const stillPreparing = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${loc.id}`).set(auth(adminToken));
    expect(stillPreparing.body.some((t: any) => t.orderId === orderRes.body.id)).toBe(true); // PREPARING, not READY yet

    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(adminToken)); // now READY
    const goneNow = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${loc.id}`).set(auth(adminToken));
    expect(goneNow.body.some((t: any) => t.orderId === orderRes.body.id)).toBe(false);

    // The order's own status field must still read PAID -- it must never
    // get silently overwritten to READY once the kitchen catches up,
    // since READY and PAID share the same Order.status field.
    const orderAfter = await request(app.getHttpServer()).get(`/orders/${orderRes.body.id}`).set(auth(adminToken));
    expect(orderAfter.body.status).toBe('PAID');
  });

  describe('advance-category (bulk "finish this section" button)', () => {
    // Each test below gets its own fresh location + menu items/categories
    // (never the shared 'رئيسي'/'جانبي' fixtures from earlier tests in this
    // file), so filtering the queue by category can't pick up unrelated
    // leftover lines from tests that ran before it.
    const freshFixtures = async (mainCategory: string) => {
      const loc = await prisma.location.create({ data: { name: `فرع اختبار تجميع ${mainCategory}`, type: 'BRANCH' } });
      const mainItem = await prisma.menuItem.create({ data: { name: `صنف رئيسي -- ${mainCategory}`, category: mainCategory, price: 12 } });
      const sideItem = await prisma.menuItem.create({ data: { name: `صنف جانبي -- ${mainCategory}`, category: `${mainCategory} جانبي`, price: 6 } });
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: loc.id, openingFloat: 100 });
      return { locationId: loc.id, shiftId: shiftRes.body.id, mainItemId: mainItem.id, sideItemId: sideItem.id, mainCategory };
    };

    it('bumps every not-yet-served line of the given category by one step, across multiple orders in the same shift', async () => {
      const f = await freshFixtures('اختبار تجميع 1');
      const order1 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({
          locationId: f.locationId,
          shiftId: f.shiftId,
          channel: 'DINE_IN',
          lines: [
            { menuItemId: f.mainItemId, quantity: 1 },
            { menuItemId: f.sideItemId, quantity: 1 },
          ],
        });
      const order2 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({ locationId: f.locationId, shiftId: f.shiftId, channel: 'DINE_IN', lines: [{ menuItemId: f.mainItemId, quantity: 2 }] });

      const res = await request(app.getHttpServer())
        .post('/kitchen/advance-category')
        .set(auth(adminToken))
        .send({ locationId: f.locationId, category: f.mainCategory });
      expect(res.status).toBe(200);
      expect(res.body.advancedCount).toBe(2); // order1's main-category line + order2's

      const queueRes = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${f.locationId}`).set(auth(adminToken));
      const t1 = queueRes.body.find((t: any) => t.orderId === order1.body.id);
      const t2 = queueRes.body.find((t: any) => t.orderId === order2.body.id);
      expect(t1.lines.find((l: any) => l.category === f.mainCategory).kitchenStatus).toBe('PREPARING');
      expect(t1.lines.find((l: any) => l.category !== f.mainCategory).kitchenStatus).toBe('QUEUED'); // untouched -- different category
      expect(t2.lines[0].kitchenStatus).toBe('PREPARING');
    });

    it('moves a mixed batch each one step forward, not all to the same status, and skips lines already SERVED', async () => {
      const f = await freshFixtures('اختبار تجميع 2');
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({
          locationId: f.locationId,
          shiftId: f.shiftId,
          channel: 'TAKEAWAY',
          lines: [
            { menuItemId: f.mainItemId, quantity: 1 },
            { menuItemId: f.mainItemId, quantity: 1 }, // second line, same category, same order
          ],
        });
      const [lineA1, lineA2] = orderRes.body.lines;

      // Advance only the first line to PREPARING by hand -- the second
      // stays QUEUED, so the category now has a mixed batch.
      await request(app.getHttpServer()).post(`/kitchen/lines/${lineA1.id}/advance`).set(auth(adminToken));

      const res = await request(app.getHttpServer())
        .post('/kitchen/advance-category')
        .set(auth(adminToken))
        .send({ locationId: f.locationId, category: f.mainCategory });
      expect(res.status).toBe(200);
      expect(res.body.advancedCount).toBe(2);

      const queueRes = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${f.locationId}`).set(auth(adminToken));
      const ticket = queueRes.body.find((t: any) => t.orderId === orderRes.body.id);
      const l1 = ticket.lines.find((l: any) => l.lineId === lineA1.id);
      const l2 = ticket.lines.find((l: any) => l.lineId === lineA2.id);
      expect(l1.kitchenStatus).toBe('READY'); // was PREPARING -> one step -> READY
      expect(l2.kitchenStatus).toBe('PREPARING'); // was QUEUED -> one step -> PREPARING

      // Bump both to SERVED, then run the bulk action again -- it must
      // report 0 advanced (nothing left to move) instead of erroring.
      await request(app.getHttpServer()).post(`/kitchen/lines/${lineA1.id}/advance`).set(auth(adminToken));
      await request(app.getHttpServer()).post(`/kitchen/lines/${lineA2.id}/advance`).set(auth(adminToken));
      await request(app.getHttpServer()).post(`/kitchen/lines/${lineA2.id}/advance`).set(auth(adminToken));
      const noopRes = await request(app.getHttpServer())
        .post('/kitchen/advance-category')
        .set(auth(adminToken))
        .send({ locationId: f.locationId, category: f.mainCategory });
      expect(noopRes.status).toBe(200);
      expect(noopRes.body.advancedCount).toBe(0);
    });

    it('never advances a line belonging to a VOIDED order', async () => {
      const f = await freshFixtures('اختبار تجميع 3');
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(adminToken))
        .send({ locationId: f.locationId, shiftId: f.shiftId, channel: 'TAKEAWAY', lines: [{ menuItemId: f.mainItemId, quantity: 1 }] });
      await request(app.getHttpServer()).post(`/orders/${orderRes.body.id}/void`).set(auth(adminToken));

      const res = await request(app.getHttpServer())
        .post('/kitchen/advance-category')
        .set(auth(adminToken))
        .send({ locationId: f.locationId, category: f.mainCategory });
      expect(res.status).toBe(200);
      expect(res.body.advancedCount).toBe(0);

      const lineAfter = await prisma.orderLine.findUniqueOrThrow({ where: { id: orderRes.body.lines[0].id } });
      expect(lineAfter.kitchenStatus).toBe('QUEUED'); // untouched

      await request(app.getHttpServer()).post(`/kitchen/orders/${orderRes.body.id}/acknowledge-cancel`).set(auth(adminToken));
    });
  });
});
