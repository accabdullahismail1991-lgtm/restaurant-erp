import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { XMLParser } from 'fast-xml-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Location.pricesIncludeVat: lets a branch price its menu the way most
// walk-in restaurants actually do -- the number on the menu/price list IS
// what the customer pays, VAT baked in, instead of VAT being added on top
// at checkout. OrdersService.create() must then EXTRACT the VAT portion
// (for reporting/ZATCA) rather than ADD it, so grandTotal never exceeds
// subtotal-discount. Proven here end-to-end: order totals, the persisted
// order record, the PATCH toggle itself, and the generated ZATCA XML
// (which must show the true tax-exclusive net, not the inclusive gross).
describe('Location.pricesIncludeVat: VAT-inclusive pricing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const ADMIN_PHONE = '+966500000080';
  const PASSWORD = 'VatInclusiveTest123';
  const VAT_NUMBER = '399999999900027';

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
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'VAT-Inclusive-Test-Admin' } } });
    await prisma.role.deleteMany({ where: { name: 'VAT-Inclusive-Test-Admin' } });

    // branches.manage (create/patch locations) + inventory.adjust (seed
    // opening stock for the test menu items) -- POST /orders, /shifts and
    // /orders/:id/pay themselves need no specific permission, matching
    // every other e2e suite's grant-only-what's-needed pattern.
    const branchesPerm = await prisma.permission.upsert({
      where: { code: 'branches.manage' },
      update: {},
      create: { code: 'branches.manage', label: 'إدارة الفروع' },
    });
    const inventoryPerm = await prisma.permission.upsert({
      where: { code: 'inventory.adjust' },
      update: {},
      create: { code: 'inventory.adjust', label: 'تسوية المخزون' },
    });
    // adminToken opens shifts as scaffolding below.
    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const role = await prisma.role.create({ data: { name: 'VAT-Inclusive-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: branchesPerm.id },
        { roleId: role.id, permissionId: inventoryPerm.id },
        { roleId: role.id, permissionId: shiftPerm.id },
      ],
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'VAT Inclusive Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('defaults pricesIncludeVat to false for a newly created branch', async () => {
    const res = await request(app.getHttpServer())
      .post('/locations')
      .set(auth(adminToken))
      .send({ name: 'فرع افتراضي', type: 'BRANCH' });
    expect(res.status).toBe(201);
    expect(res.body.pricesIncludeVat).toBe(false);
  });

  it('toggles pricesIncludeVat via PATCH /locations/:id', async () => {
    const created = await request(app.getHttpServer()).post('/locations').set(auth(adminToken)).send({ name: 'فرع للتفعيل', type: 'BRANCH' });
    const id = created.body.id;
    const patched = await request(app.getHttpServer()).patch(`/locations/${id}`).set(auth(adminToken)).send({ pricesIncludeVat: true });
    expect(patched.status).toBe(200);
    expect(patched.body.pricesIncludeVat).toBe(true);

    const fetched = await request(app.getHttpServer()).get(`/locations/${id}`).set(auth(adminToken));
    expect(fetched.body.pricesIncludeVat).toBe(true);
  });

  it('extracts VAT instead of adding it on top when pricesIncludeVat is true (grandTotal == subtotal)', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع سعر شامل الضريبة', type: 'BRANCH', pricesIncludeVat: true } });
    const ingredient = await prisma.ingredient.create({ data: { name: 'خامة شاملة الضريبة', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
    // price=40 is the FINAL price the customer pays (VAT already inside it)
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف شامل الضريبة', category: 'رئيسي', price: 40 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 1 } });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId: location.id, ingredientId: ingredient.id, quantity: 100, unitCost: 1 });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: 2 }] });
    expect(res.status).toBe(201);
    // subtotal = 40 x 2 = 80, already VAT-inclusive
    expect(Number(res.body.subtotal)).toBe(80);
    // vatTotal is the 15% EXTRACTED from 80, not added: 80 - 80/1.15 = 10.43
    expect(Number(res.body.vatTotal)).toBeCloseTo(10.43, 2);
    // grandTotal must equal subtotal (nothing added on top) -- exactly what's on the menu
    expect(Number(res.body.grandTotal)).toBe(80);

    // Paying exactly the (unchanged-by-VAT) grand total must succeed.
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${res.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: 80 }] });
    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('PAID');
  });

  it('spreads a manual discount before extracting VAT, still landing on grandTotal == subtotal - discount', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع خصم مع ضريبة شاملة', type: 'BRANCH', pricesIncludeVat: true } });
    const permission = await prisma.permission.upsert({
      where: { code: 'pos.apply_discount' },
      update: {},
      create: { code: 'pos.apply_discount', label: 'تطبيق خصم يدوي' },
    });
    const role = await prisma.role.create({ data: { name: `Discount-Role-${location.id}` } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { phone: ADMIN_PHONE } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });

    const ingredient = await prisma.ingredient.create({ data: { name: `خامة خصم ${location.id}`, unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
    const menuItem = await prisma.menuItem.create({ data: { name: `صنف خصم ${location.id}`, category: 'رئيسي', price: 100 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 1 } });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId: location.id, ingredientId: ingredient.id, quantity: 100, unitCost: 1 });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', discountTotal: 10, lines: [{ menuItemId: menuItem.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.subtotal)).toBe(100);
    expect(Number(res.body.discountTotal)).toBe(10);
    // grandTotal = subtotal - discount, still nothing added for VAT
    expect(Number(res.body.grandTotal)).toBe(90);
    // vatTotal extracted from the discounted taxable base (90): 90 - 90/1.15 = 11.74
    expect(Number(res.body.vatTotal)).toBeCloseTo(11.74, 2);
  });

  it('leaves the original tax-exclusive (VAT added on top) behavior unchanged when pricesIncludeVat is false', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع سعر غير شامل الضريبة', type: 'BRANCH', pricesIncludeVat: false } });
    const ingredient = await prisma.ingredient.create({ data: { name: `خامة غير شاملة ${location.id}`, unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
    const menuItem = await prisma.menuItem.create({ data: { name: `صنف غير شامل ${location.id}`, category: 'رئيسي', price: 40 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 1 } });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId: location.id, ingredientId: ingredient.id, quantity: 100, unitCost: 1 });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.subtotal)).toBe(80);
    expect(Number(res.body.vatTotal)).toBe(12); // 80 * 0.15, added on top
    expect(Number(res.body.grandTotal)).toBe(92); // 80 + 12
  });

  it('generates a ZATCA XML whose net amounts are correctly backed out of an inclusive price', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع فوترة شاملة الضريبة', type: 'BRANCH', pricesIncludeVat: true, vatNumber: VAT_NUMBER } });
    const ingredient = await prisma.ingredient.create({ data: { name: `خامة فوترة ${location.id}`, unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
    const menuItem = await prisma.menuItem.create({ data: { name: `صنف فوترة ${location.id}`, category: 'رئيسي', price: 40 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 1 } });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId: location.id, ingredientId: ingredient.id, quantity: 100, unitCost: 1 });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: 2 }] });
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    expect(payRes.body.zatcaSyncStatus).toBe('GENERATED');

    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(payRes.body.zatcaXml);
    const totals = parsed.Invoice['cac:LegalMonetaryTotal'];
    // TaxInclusiveAmount / PayableAmount == what the customer actually pays (80.00)
    expect(Number(totals['cbc:TaxInclusiveAmount']['#text'])).toBeCloseTo(80, 2);
    expect(Number(totals['cbc:PayableAmount']['#text'])).toBeCloseTo(80, 2);
    // LineExtensionAmount / TaxExclusiveAmount must be the NET amount backed
    // out of the inclusive price (80 / 1.15 = 69.57), never the raw 80.
    expect(Number(totals['cbc:LineExtensionAmount']['#text'])).toBeCloseTo(69.57, 2);
    expect(Number(totals['cbc:TaxExclusiveAmount']['#text'])).toBeCloseTo(69.57, 2);
    expect(Number(parsed.Invoice['cac:TaxTotal']['cbc:TaxAmount']['#text'])).toBeCloseTo(10.43, 2);

    const line = parsed.Invoice['cac:InvoiceLine'];
    expect(Number(line['cbc:LineExtensionAmount']['#text'])).toBeCloseTo(69.57, 2);
    expect(Number(line['cac:TaxTotal']['cbc:TaxAmount']['#text'])).toBeCloseTo(10.43, 2);
  });
});
