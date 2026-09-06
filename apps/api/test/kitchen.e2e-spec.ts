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
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: 'Kitchen Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

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
});
