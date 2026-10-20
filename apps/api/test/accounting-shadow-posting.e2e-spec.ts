import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 0 of the reporting-architecture doc, step 2 of the rollout plan:
// shadow posting. No GL report is exposed anywhere yet -- these tests read
// JournalEntry/JournalLine directly via Prisma (the same way the rest of
// the suite backdates a date or inspects an internal table nothing public
// exposes), exactly as the rollout plan's own step 3 ("reconcile against
// what already exists") describes doing before any report goes live.
describe('Accounting shadow-posting (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;

  const PHONE = '+966500000350';
  const PASSWORD = 'ShadowPostingTest123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const sumByAccount = async (entryId: string, code: string) => {
    const account = await prisma.account.findUniqueOrThrow({ where: { code } });
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entryId, accountId: account.id } });
    return {
      debit: round2(lines.reduce((s, l) => s + Number(l.debit), 0)),
      credit: round2(lines.reduce((s, l) => s + Number(l.credit), 0)),
    };
  };

  const assertBalanced = async (entryId: string) => {
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entryId } });
    const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit), 0));
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeGreaterThan(0);
  };

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
    await prisma.role.deleteMany({ where: { name: 'ShadowPosting-Test-Role' } });
    const permCodes = [
      'ingredients.view', 'ingredients.manage', 'inventory.view', 'inventory.adjust',
      'items.manage', 'purchasing.view', 'purchasing.create_po', 'pos.manage_shift',
    ];
    await prisma.permission.deleteMany({ where: { code: { in: permCodes } } });

    const perms = await Promise.all(permCodes.map((code) => prisma.permission.create({ data: { code, label: code } })));
    const role = await prisma.role.create({ data: { name: 'ShadowPosting-Test-Role' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار الترحيل الصامت', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('posts a balanced compound entry for an order payment: cash/card, revenue, VAT, and COGS', async () => {
    const h = auth(token);
    const api = request(app.getHttpServer());

    const ing = (await api.post('/ingredients').set(h).send({ name: 'دقيق ترحيل صامت', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 })).body;
    await api.post('/inventory/adjustments').set(h).send({ locationId, ingredientId: ing.id, quantity: 100, unitCost: 3 });

    const item = (await api.post('/items').set(h).send({ name: 'صنف ترحيل صامت', category: 'اختبار', price: 50 })).body;
    await api.put(`/items/${item.id}/recipe`).set(h).send({ lines: [{ ingredientId: ing.id, quantity: 2 }] });

    const shift = (await api.post('/shifts').set(h).send({ locationId, openingFloat: 100 })).body;
    const order = (await api.post('/orders').set(h).send({ locationId, shiftId: shift.id, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 3 }] })).body;

    const grandTotal = Number(order.grandTotal);
    const vatTotal = Number(order.vatTotal);
    const netRevenue = round2(grandTotal - vatTotal);

    const payRes = await api.post(`/orders/${order.id}/pay`).set(h).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: grandTotal }] });
    expect(payRes.status).toBe(200);

    const entry = await prisma.journalEntry.findFirst({ where: { sourceType: 'ORDER_PAYMENT', sourceId: order.id } });
    expect(entry).not.toBeNull();
    await assertBalanced(entry!.id);

    const cash = await sumByAccount(entry!.id, '1000');
    expect(cash.debit).toBe(grandTotal);

    const revenue = await sumByAccount(entry!.id, '4000');
    expect(revenue.credit).toBe(netRevenue);

    if (vatTotal > 0) {
      const vat = await sumByAccount(entry!.id, '2300');
      expect(vat.credit).toBe(vatTotal);
    }

    // COGS: 3 units x 2kg/unit x 3.00/kg = 18.00, independently re-derived
    // from StockMovement by the posting rule, not copied from a number this
    // test already trusts -- a real reconciliation, not a tautology.
    const cogs = await sumByAccount(entry!.id, '5000');
    expect(cogs.debit).toBe(18);
    const inventoryCredit = await sumByAccount(entry!.id, '1200');
    expect(inventoryCredit.credit).toBe(18);
  });

  it('posts a balanced entry for a received purchase order: inventory, VAT receivable, and accounts payable', async () => {
    const h = auth(token);
    const api = request(app.getHttpServer());

    const ing = (await api.post('/ingredients').set(h).send({ name: 'سكر ترحيل صامت', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 })).body;
    const supplier = (await api.post('/suppliers').set(h).send({ name: 'مورد ترحيل صامت' })).body;

    const po = (await api.post('/purchase-orders').set(h).send({
      locationId, supplierId: supplier.id, lines: [{ ingredientId: ing.id, quantity: 50, unitCost: 4 }],
    })).body;
    await api.post(`/purchase-orders/${po.id}/submit`).set(h); // no ApprovalRule exists -> auto-approves
    const receiveRes = await api.post(`/purchase-orders/${po.id}/receive`).set(h);
    expect(receiveRes.status).toBe(200);

    const entry = await prisma.journalEntry.findFirst({ where: { sourceType: 'PURCHASE_ORDER_RECEIVE', sourceId: po.id } });
    expect(entry).not.toBeNull();
    await assertBalanced(entry!.id);

    const totalAmount = Number(receiveRes.body.totalAmount ?? po.totalAmount);
    const vatTotal = Number(po.vatTotal);

    const ap = await sumByAccount(entry!.id, '2000');
    expect(ap.credit).toBe(totalAmount);

    const inv = await sumByAccount(entry!.id, '1200');
    expect(inv.debit).toBe(round2(totalAmount - vatTotal));

    if (vatTotal > 0) {
      const vatReceivable = await sumByAccount(entry!.id, '1300');
      expect(vatReceivable.debit).toBe(vatTotal);
    }
  });

  it('posts a balanced waste entry: expense against inventory, at the real depleted-batch cost', async () => {
    const h = auth(token);
    const api = request(app.getHttpServer());

    const ing = (await api.post('/ingredients').set(h).send({ name: 'بيض ترحيل صامت', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 })).body;
    await api.post('/inventory/adjustments').set(h).send({ locationId, ingredientId: ing.id, quantity: 20, unitCost: 6 });

    const wasteRes = await api.post('/inventory/waste').set(h).send({ locationId, ingredientId: ing.id, quantity: 5 });
    expect(wasteRes.status).toBe(201);

    const entry = await prisma.journalEntry.findFirst({ where: { sourceType: 'WASTE', description: { contains: ing.id } } });
    expect(entry).not.toBeNull();
    await assertBalanced(entry!.id);

    const wasteExpense = await sumByAccount(entry!.id, '5100');
    expect(wasteExpense.debit).toBe(30); // 5kg x 6.00/kg
    const inventoryCredit = await sumByAccount(entry!.id, '1200');
    expect(inventoryCredit.credit).toBe(30);
  });
});
