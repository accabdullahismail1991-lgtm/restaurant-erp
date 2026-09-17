import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { XMLParser } from 'fast-xml-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Returns-log improvement, part 2: every OrderReturn now gets its own
// ZATCA Credit Note (InvoiceTypeCode 381), generated/signed exactly like
// OrdersService.pay() already does for a Tax Invoice, chained into the
// SAME per-location ICV/PIH sequence -- and its own independent audit
// trail (OrderReturnActivityLog). These tests prove the chaining is
// genuinely unified (a credit note advances the chain a later invoice
// must reference) and that the activity log never claims ZATCA generation
// that was actually skipped.
describe('Returns credit note (ZATCA) + return activity log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let noVatLocationId: string;
  let menuItemId: string;

  const PHONE = '+966500000190';
  const PASSWORD = 'CreditNoteTest123';
  const VAT_NUMBER = '399999999900099';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    // A prior run of this same suite against this persistent DB may have
    // left a UserRole row referencing this phone's user (no afterAll
    // cleanup) -- delete it first so the user delete below doesn't hit
    // UserRole_userId_fkey.
    await prisma.userRole.deleteMany({ where: { user: { phone: PHONE } } });
    await prisma.user.deleteMany({ where: { phone: PHONE } });
    await prisma.role.deleteMany({ where: { name: 'CreditNote-Test-Role' } });

    // Upserted, not deleted -- other suites sharing this DB (see
    // reset-db.ts's own comment: Permission/Role rows are NOT wiped by
    // resetDatabase) may already have a role referencing this permission,
    // so a delete-then-recreate would hit the same FK violation
    // returns.e2e-spec.ts's own suite risks if run out of order.
    const returnPerm = await prisma.permission.upsert({
      where: { code: 'pos.return_order' },
      update: {},
      create: { code: 'pos.return_order', label: 'تسجيل مرتجع عميل' },
    });
    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const role = await prisma.role.create({ data: { name: 'CreditNote-Test-Role' } });
    await prisma.rolePermission.createMany({ data: [returnPerm, shiftPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: 'Credit Note Tester', phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار إشعار الدائن', type: 'BRANCH', vatNumber: VAT_NUMBER } });
    locationId = location.id;
    const noVatLocation = await prisma.location.create({ data: { name: 'فرع بلا رقم ضريبي لإشعار الدائن', type: 'BRANCH' } });
    noVatLocationId = noVatLocation.id;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار إشعار الدائن', category: 'اختبار', price: 40 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function placeAndPayReadyOrder(targetLocationId: string) {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId: targetLocationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId: targetLocationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(token))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    const lineId = orderRes.body.lines[0].id;
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(token));
    await request(app.getHttpServer()).post(`/kitchen/lines/${lineId}/advance`).set(auth(token));
    return { order: payRes.body, shiftId, lineId };
  }

  it('generates a signed ZATCA credit note for a return, chained after the order\'s own invoice', async () => {
    const { order, lineId } = await placeAndPayReadyOrder(locationId);
    expect(order.zatcaInvoiceCounter).toBe(1); // the order's own tax invoice is the chain's first document

    const returnRes = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(token))
      .send({ orderId: order.id, lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect(returnRes.status).toBe(201);
    const ret = returnRes.body;

    expect(ret.zatcaSyncStatus).toBe('GENERATED');
    expect(typeof ret.zatcaXml).toBe('string');
    expect(typeof ret.zatcaQrCode).toBe('string');
    // Chained immediately after the order's own invoice at this location.
    expect(ret.zatcaInvoiceCounter).toBe(2);
    const expectedPih = Buffer.from(Buffer.from(order.zatcaInvoiceHash, 'base64').toString('hex')).toString('base64');
    expect(ret.zatcaPreviousInvoiceHash).toBe(expectedPih);

    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(ret.zatcaXml);
    expect(Number(parsed.Invoice['cbc:InvoiceTypeCode']['#text'] ?? parsed.Invoice['cbc:InvoiceTypeCode'])).toBe(381);
    expect(parsed.Invoice['cac:BillingReference']['cac:InvoiceDocumentReference']['cbc:ID']).toBe(order.id);
    expect(Number(parsed.Invoice['cac:LegalMonetaryTotal']['cbc:PayableAmount']['#text'])).toBeCloseTo(Number(ret.refundTotal), 2);

    // The credit note's own hash genuinely matches SHA-256 of its stored XML.
    const recomputedHash = require('crypto').createHash('sha256').update(Buffer.from(ret.zatcaXml, 'utf8')).digest();
    expect(Buffer.from(ret.zatcaInvoiceHash, 'base64').equals(recomputedHash)).toBe(true);
  });

  it('a later invoice at the same location chains its PIH from the credit note, not just from prior invoices', async () => {
    const { order: order1, lineId: line1 } = await placeAndPayReadyOrder(locationId);
    const returnRes = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(token))
      .send({ orderId: order1.id, lines: [{ orderLineId: line1, quantity: 1 }] });
    const ret = returnRes.body;

    const { order: order2 } = await placeAndPayReadyOrder(locationId);
    expect(order2.zatcaInvoiceCounter).toBe(ret.zatcaInvoiceCounter + 1);
    const expectedPih = Buffer.from(Buffer.from(ret.zatcaInvoiceHash, 'base64').toString('hex')).toString('base64');
    expect(order2.zatcaPreviousInvoiceHash).toBe(expectedPih);
  });

  it('skips credit-note generation (stays PENDING) for a location with no vatNumber, and logs CREATED only', async () => {
    const { order, lineId } = await placeAndPayReadyOrder(noVatLocationId);
    expect(order.zatcaSyncStatus).toBe('PENDING');

    const returnRes = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(token))
      .send({ orderId: order.id, lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect(returnRes.status).toBe(201);
    expect(returnRes.body.zatcaSyncStatus).toBe('PENDING');
    expect(returnRes.body.zatcaXml).toBeNull();

    const detail = await request(app.getHttpServer()).get(`/returns/${returnRes.body.id}`).set(auth(token));
    expect(detail.status).toBe(200);
    const actions = detail.body.activityLog.map((a: { action: string }) => a.action);
    expect(actions).toContain('CREATED');
    expect(actions).not.toContain('ZATCA_CREDIT_NOTE_GENERATED');
  });

  it('GET /returns/:id gives full detail including net/vat per line and the ZATCA_CREDIT_NOTE_GENERATED entry', async () => {
    const { order, lineId } = await placeAndPayReadyOrder(locationId);
    const returnRes = await request(app.getHttpServer())
      .post('/returns')
      .set(auth(token))
      .send({ orderId: order.id, lines: [{ orderLineId: lineId, quantity: 1 }] });

    const detail = await request(app.getHttpServer()).get(`/returns/${returnRes.body.id}`).set(auth(token));
    expect(detail.status).toBe(200);
    expect(detail.body.order.id).toBe(order.id);
    expect(detail.body.createdBy.name).toBe('Credit Note Tester');
    expect(Number(detail.body.lines[0].netAmount) + Number(detail.body.lines[0].vatAmount)).toBeCloseTo(Number(detail.body.lines[0].refundAmount), 2);
    const actions = detail.body.activityLog.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['CREATED', 'ZATCA_CREDIT_NOTE_GENERATED']));
  });

  it('rejects GET /returns/:id for an unknown id (404)', async () => {
    const res = await request(app.getHttpServer()).get('/returns/does-not-exist').set(auth(token));
    expect(res.status).toBe(404);
  });
});
