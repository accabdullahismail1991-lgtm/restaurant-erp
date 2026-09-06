import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 5: suppliers + the Approval Matrix + the full PurchaseOrder
// lifecycle (draft -> submit -> approve/reject -> send -> receive ->
// cancel), receiving landing as REAL InventoryBatch rows via the same
// InventoryService Phase 3+4 built. Runs against a real app + a real
// Postgres test database, same as every other suite.
describe('Phase 5: purchasing + approval matrix (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string; // purchasing.create_po + purchasing.approve_po + purchasing.manage_rules
  let noPermToken: string;
  let juniorToken: string; // purchasing.approve_po but NOT the matrix-required role
  let seniorToken: string; // purchasing.approve_po AND the matrix-required role
  let locationId: string;
  let otherLocationId: string;
  let supplierId: string;
  let ingredientId: string;
  let maliyRoleId: string;

  const ADMIN_PHONE = '+966500000030';
  const NOPERM_PHONE = '+966500000031';
  const JUNIOR_PHONE = '+966500000032';
  const SENIOR_PHONE = '+966500000033';
  const PASSWORD = 'TestPass123';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    // resetDatabase() clears every suite's domain tables first (see
    // test/reset-db.ts), so leftover rows from any other suite's
    // interrupted previous run never break this suite's own cleanup.
    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE, JUNIOR_PHONE, SENIOR_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'Purch-Test-' } } });
    await prisma.permission.deleteMany({
      where: { code: { in: ['purchasing.create_po', 'purchasing.approve_po', 'purchasing.manage_rules'] } },
    });

    const createPoPerm = await prisma.permission.create({ data: { code: 'purchasing.create_po', label: 'إنشاء أوامر شراء' } });
    const approvePoPerm = await prisma.permission.create({ data: { code: 'purchasing.approve_po', label: 'اعتماد أوامر الشراء' } });
    const manageRulesPerm = await prisma.permission.create({ data: { code: 'purchasing.manage_rules', label: 'إدارة مصفوفة الموافقات' } });

    const adminRole = await prisma.role.create({ data: { name: 'Purch-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [createPoPerm, approvePoPerm, manageRulesPerm].map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
    });

    const juniorRole = await prisma.role.create({ data: { name: 'Purch-Test-Junior' } });
    await prisma.rolePermission.create({ data: { roleId: juniorRole.id, permissionId: approvePoPerm.id } });

    // The role the Approval Matrix rule will actually name as required --
    // separate from "holds purchasing.approve_po" (the coarse baseline
    // gate every approver-ish role needs).
    const maliyRole = await prisma.role.create({ data: { name: 'Purch-Test-Maliy' } });
    await prisma.rolePermission.create({ data: { roleId: maliyRole.id, permissionId: approvePoPerm.id } });
    maliyRoleId = maliyRole.id;

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, adminRole.id);
    noPermToken = await makeUser(NOPERM_PHONE);
    juniorToken = await makeUser(JUNIOR_PHONE, juniorRole.id);
    seniorToken = await makeUser(SENIOR_PHONE, maliyRole.id);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار المشتريات', type: 'BRANCH' } });
    locationId = location.id;
    const otherLocation = await prisma.location.create({ data: { name: 'فرع اختبار مشتريات آخر', type: 'BRANCH' } });
    otherLocationId = otherLocation.id;

    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة اختبار مشتريات', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    ingredientId = ingredient.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('blocks a user without purchasing.create_po from creating a supplier or PO (403)', async () => {
    const supplierRes = await request(app.getHttpServer())
      .post('/suppliers')
      .set(auth(noPermToken))
      .send({ name: 'مورد بدون صلاحية' });
    expect(supplierRes.status).toBe(403);
  });

  it('creates a supplier available to every location', async () => {
    const res = await request(app.getHttpServer()).post('/suppliers').set(auth(adminToken)).send({ name: 'مورد عام' });
    expect(res.status).toBe(201);
    supplierId = res.body.id;
  });

  it('rejects a PO against a supplier scoped to a different location', async () => {
    const scopedSupplierRes = await request(app.getHttpServer())
      .post('/suppliers')
      .set(auth(adminToken))
      .send({ name: 'مورد محلي', scopeLocationId: otherLocationId });
    const scopedSupplierId = scopedSupplierRes.body.id;

    const res = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(adminToken))
      .send({ locationId, supplierId: scopedSupplierId, lines: [{ ingredientId, quantity: 1, unitCost: 1 }] });
    expect(res.status).toBe(400);
  });

  let noRuleDraftId: string;

  it('creates a PO in DRAFT with a server-computed totalAmount', async () => {
    const res = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(adminToken))
      .send({ locationId, supplierId, lines: [{ ingredientId, quantity: 10, unitCost: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(Number(res.body.totalAmount)).toBe(20);
    noRuleDraftId = res.body.id;
  });

  it('auto-approves on submit when no Approval Matrix rule covers this location/amount', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${noRuleDraftId}/submit`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('receiving creates a real InventoryBatch and bumps the balance', async () => {
    const before = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const beforeQty = before.body.find((b: any) => b.ingredientId === ingredientId)?.quantity ?? 0;

    const res = await request(app.getHttpServer()).post(`/purchase-orders/${noRuleDraftId}/receive`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RECEIVED');

    const after = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const afterQty = Number(after.body.find((b: any) => b.ingredientId === ingredientId).quantity);
    expect(afterQty).toBe(Number(beforeQty) + 10);

    const batch = await prisma.inventoryBatch.findFirst({ where: { sourceType: 'PURCHASE', sourceId: noRuleDraftId } });
    expect(batch).not.toBeNull();
    expect(Number(batch!.unitCost)).toBe(2);
  });

  it('rejects cancelling an already-RECEIVED PO', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${noRuleDraftId}/cancel`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it('blocks a user without purchasing.manage_rules from configuring the Approval Matrix (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval-rules')
      .set(auth(noPermToken))
      .send({ documentType: 'PURCHASE_ORDER', maxAmount: 100, requiredRoleId: maliyRoleId });
    expect(res.status).toBe(403);
  });

  it('configures an Approval Matrix rule: PURCHASE_ORDER over 100 SAR needs the "مالي" role', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval-rules')
      .set(auth(adminToken))
      .send({ documentType: 'PURCHASE_ORDER', maxAmount: 100, requiredRoleId: maliyRoleId });
    expect(res.status).toBe(201);
  });

  let pendingPoId: string;

  it('a PO over the threshold goes to PENDING_APPROVAL on submit instead of auto-approving', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(adminToken))
      .send({ locationId, supplierId, lines: [{ ingredientId, quantity: 100, unitCost: 2 }] }); // total = 200
    pendingPoId = createRes.body.id;

    const submitRes = await request(app.getHttpServer()).post(`/purchase-orders/${pendingPoId}/submit`).set(auth(adminToken));
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('PENDING_APPROVAL');
  });

  it('rejects approval from someone who holds purchasing.approve_po but NOT the matrix-required role (403)', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${pendingPoId}/approve`).set(auth(juniorToken));
    expect(res.status).toBe(403);
  });

  it('rejects approval from someone with neither purchasing.approve_po nor the matrix role -- the coarse permission gate blocks it first', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${pendingPoId}/approve`).set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('approves as the specific role the matrix requires', async () => {
    const res = await request(app.getHttpServer())
      .post(`/purchase-orders/${pendingPoId}/approve`)
      .set(auth(seniorToken))
      .send({ note: 'موافق -- ضمن الميزانية' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('rejects submitting a PO that is not a DRAFT any more', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${pendingPoId}/submit`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it('moves an APPROVED PO to SENT_TO_SUPPLIER and then RECEIVED', async () => {
    const sendRes = await request(app.getHttpServer()).post(`/purchase-orders/${pendingPoId}/send`).set(auth(adminToken));
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.status).toBe('SENT_TO_SUPPLIER');

    const receiveRes = await request(app.getHttpServer()).post(`/purchase-orders/${pendingPoId}/receive`).set(auth(adminToken));
    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('RECEIVED');
  });

  let rejectedPoId: string;

  it('rejects a PO over the threshold as the required role, with a note', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(adminToken))
      .send({ locationId, supplierId, lines: [{ ingredientId, quantity: 60, unitCost: 2 }] }); // total = 120
    rejectedPoId = createRes.body.id;
    await request(app.getHttpServer()).post(`/purchase-orders/${rejectedPoId}/submit`).set(auth(adminToken));

    const res = await request(app.getHttpServer())
      .post(`/purchase-orders/${rejectedPoId}/reject`)
      .set(auth(seniorToken))
      .send({ note: 'يتجاوز الميزانية الشهرية' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
  });

  it('rejects receiving a REJECTED PO', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${rejectedPoId}/receive`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let draftForCancelId: string;

  it('blocks a user without purchasing.create_po from submitting someone else\'s draft (403)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(adminToken))
      .send({ locationId, supplierId, lines: [{ ingredientId, quantity: 5, unitCost: 1 }] });
    draftForCancelId = createRes.body.id;

    const res = await request(app.getHttpServer()).post(`/purchase-orders/${draftForCancelId}/submit`).set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('cancels a DRAFT PO directly', async () => {
    const res = await request(app.getHttpServer()).post(`/purchase-orders/${draftForCancelId}/cancel`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  it('lists and reads back purchase orders scoped to their location', async () => {
    const listRes = await request(app.getHttpServer()).get(`/purchase-orders?locationId=${locationId}`).set(auth(adminToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(4);

    const getRes = await request(app.getHttpServer()).get(`/purchase-orders/${pendingPoId}`).set(auth(adminToken));
    expect(getRes.status).toBe(200);
    expect(getRes.body.lines).toHaveLength(1);
    expect(getRes.body.approvals).toHaveLength(1);
  });
});
