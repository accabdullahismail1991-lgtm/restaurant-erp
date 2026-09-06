import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { createVerify } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { decodeQr } from '../src/zatca/qr.util';
import { resetDatabase } from './reset-db';

// Phase 9: ZATCA invoice generation/signing, built and verified LOCALLY
// (docs/DECISIONS.md #3) -- there is no real ZATCA sandbox account
// reachable from this environment (see docs/ARCHITECTURE.md's Phase 9
// section for why), so these tests prove the LOCAL half is genuinely
// correct: a real ECDSA signature that verifies against the stored public
// key with Node's own crypto (not a string-equality stand-in), and a QR
// code that decodes back to the exact source data through the same
// TLV/Base64 structure any real reader would use. Submitting to ZATCA's
// actual platform is a separate, explicitly unimplemented step (tested
// below to fail honestly, not silently).
describe('Phase 9: ZATCA invoice generation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let noVatLocationId: string;
  let menuItemId: string;
  let shiftId: string;
  let noVatShiftId: string;

  const ADMIN_PHONE = '+966500000070';
  const PASSWORD = 'ZatcaTest123';
  const VAT_NUMBER = '399999999900003';

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
    await prisma.user.create({ data: { name: 'Zatca Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار الفوترة', type: 'BRANCH', vatNumber: VAT_NUMBER } });
    locationId = location.id;
    const noVatLocation = await prisma.location.create({ data: { name: 'فرع بلا رقم ضريبي', type: 'BRANCH' } });
    noVatLocationId = noVatLocation.id;

    const menuItem = await prisma.menuItem.create({ data: { name: 'وجبة اختبار ZATCA', category: 'رئيسي', price: 40 } });
    menuItemId = menuItem.id;

    // One shift per location, reused across every test that hits it --
    // the API allows only one OPEN shift per location at a time, and each
    // test only needs a NEW order within it, not a new shift.
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
    const noVatShiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: noVatLocationId, openingFloat: 100 });
    noVatShiftId = noVatShiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const payFreshOrder = async (targetLocationId: string, targetShiftId: string) => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: targetLocationId, shiftId: targetShiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    const orderId = orderRes.body.id;
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    return payRes.body;
  };

  it('skips ZATCA generation (stays PENDING) when the location has no vatNumber configured', async () => {
    const paid = await payFreshOrder(noVatLocationId, noVatShiftId);
    expect(paid.status).toBe('PAID'); // payment itself must never be blocked by this
    expect(paid.zatcaSyncStatus).toBe('PENDING');
    expect(paid.zatcaXml).toBeNull();
    expect(paid.zatcaQrCode).toBeNull();
  });

  it('generates and signs a real invoice at pay() time for a location with a vatNumber', async () => {
    const paid = await payFreshOrder(locationId, shiftId);
    expect(paid.status).toBe('PAID');
    expect(paid.zatcaSyncStatus).toBe('GENERATED');
    expect(paid.zatcaUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof paid.zatcaXml).toBe('string');
    expect(typeof paid.zatcaInvoiceHash).toBe('string');
    expect(typeof paid.zatcaSignature).toBe('string');
    expect(typeof paid.zatcaPublicKey).toBe('string');
    expect(typeof paid.zatcaQrCode).toBe('string');

    // 1) The XML is genuinely well-formed and carries the required nodes --
    // parsed with a real XML parser, not regex string-matching.
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(paid.zatcaXml);
    expect(parsed.Invoice['cbc:UUID']).toBe(paid.zatcaUuid);
    expect(parsed.Invoice['cbc:ID']).toBe(paid.id);
    // fast-xml-parser auto-coerces numeric-looking text content to a JS
    // number by default -- String(...) here just undoes that parsing
    // convenience, it isn't testing anything about our XML generation.
    expect(String(parsed.Invoice['cac:AccountingSupplierParty']['cac:Party']['cac:PartyTaxScheme']['cbc:CompanyID'])).toBe(VAT_NUMBER);
    expect(Number(parsed.Invoice['cac:LegalMonetaryTotal']['cbc:PayableAmount']['#text'])).toBeCloseTo(Number(paid.grandTotal), 2);
    expect(Number(parsed.Invoice['cac:TaxTotal']['cbc:TaxAmount']['#text'])).toBeCloseTo(Number(paid.vatTotal), 2);

    // 2) The hash actually matches SHA-256 of the stored XML -- an
    // independent recomputation, not trusting the stored value blindly.
    const recomputedHash = require('crypto').createHash('sha256').update(Buffer.from(paid.zatcaXml, 'utf8')).digest();
    expect(Buffer.from(paid.zatcaInvoiceHash, 'base64').equals(recomputedHash)).toBe(true);

    // 3) The ECDSA signature genuinely verifies against the stored public
    // key using Node's own crypto.verify -- real cryptographic proof, not
    // an assertion that two strings happen to match.
    const publicKeyDer = Buffer.from(paid.zatcaPublicKey, 'base64');
    const publicKey = require('crypto').createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    const verifier = createVerify('sha256');
    verifier.update(Buffer.from(paid.zatcaXml, 'utf8'));
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(paid.zatcaSignature, 'base64'))).toBe(true);

    // A signature made with a DIFFERENT key must NOT verify -- proves the
    // check above isn't vacuously true.
    const { generateKeyPairSync } = require('crypto');
    const { publicKey: otherPublicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const verifier2 = createVerify('sha256');
    verifier2.update(Buffer.from(paid.zatcaXml, 'utf8'));
    verifier2.end();
    expect(verifier2.verify(otherPublicKey, Buffer.from(paid.zatcaSignature, 'base64'))).toBe(false);

    // 4) The QR decodes back through the exact TLV/Base64 structure a real
    // reader would use, and every tag matches the source order/location
    // data -- a genuine round-trip proof, not asserting against our own
    // encoder's internal state.
    const tags = decodeQr(paid.zatcaQrCode);
    expect(tags.get(1)!.toString('utf8')).toBe('فرع اختبار الفوترة');
    expect(tags.get(2)!.toString('utf8')).toBe(VAT_NUMBER);
    expect(tags.get(4)!.toString('utf8')).toBe(Number(paid.grandTotal).toFixed(2));
    expect(tags.get(5)!.toString('utf8')).toBe(Number(paid.vatTotal).toFixed(2));
    expect(tags.get(6)!.equals(recomputedHash)).toBe(true);
    expect(tags.get(7)!.equals(Buffer.from(paid.zatcaSignature, 'base64'))).toBe(true);
    expect(tags.get(8)!.equals(publicKeyDer)).toBe(true);
  });

  it('GET /orders/:id reflects the same generated invoice fields (persisted, not just returned once)', async () => {
    const paid = await payFreshOrder(locationId, shiftId);
    const res = await request(app.getHttpServer()).get(`/orders/${paid.id}`).set(auth(adminToken));
    expect(res.body.zatcaSyncStatus).toBe('GENERATED');
    expect(res.body.zatcaQrCode).toBe(paid.zatcaQrCode);
  });

  it('honestly reports ZATCA submission as unavailable rather than faking success', async () => {
    const paid = await payFreshOrder(locationId, shiftId);
    const res = await request(app.getHttpServer()).post(`/orders/${paid.id}/zatca/submit`).set(auth(adminToken));
    expect(res.status).toBe(503);
    expect(res.body.message).toContain('ZATCA');
  });
});
