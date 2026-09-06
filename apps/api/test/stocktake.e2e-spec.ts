import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 4b: Stocktake -- the leftover piece of Phase 4. Compares the
// theoretical InventoryBalance to what was physically counted, and any
// non-zero variance is routed through the SAME Approval Matrix
// (ApprovalRulesService.findApplicableRule, documentType=
// 'STOCKTAKE_ADJUSTMENT') Purchasing uses, then applied via
// InventoryService.consume/receive. Runs against a real app + a real
// Postgres test database, same as every other suite.
describe('Phase 4b: stocktake (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string; // inventory.adjust + purchasing.manage_rules
  let noPermToken: string;
  let juniorToken: string; // inventory.adjust but NOT the matrix-required role
  let seniorToken: string; // inventory.adjust AND the matrix-required role
  let locationId: string;
  let ingredientId: string;
  let seniorRoleId: string;

  const ADMIN_PHONE = '+966500000060';
  const NOPERM_PHONE = '+966500000061';
  const JUNIOR_PHONE = '+966500000062';
  const SENIOR_PHONE = '+966500000063';
  const PASSWORD = 'TestPass123';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE, JUNIOR_PHONE, SENIOR_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'Stocktake-Test-' } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['inventory.adjust', 'purchasing.manage_rules'] } } });

    const inventoryPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const rulesPerm = await prisma.permission.create({ data: { code: 'purchasing.manage_rules', label: 'إدارة مصفوفة الموافقات' } });

    const adminRole = await prisma.role.create({ data: { name: 'Stocktake-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [inventoryPerm, rulesPerm].map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
    });
    const juniorRole = await prisma.role.create({ data: { name: 'Stocktake-Test-Junior' } });
    await prisma.rolePermission.create({ data: { roleId: juniorRole.id, permissionId: inventoryPerm.id } });
    const seniorRole = await prisma.role.create({ data: { name: 'Stocktake-Test-Senior' } });
    await prisma.rolePermission.create({ data: { roleId: seniorRole.id, permissionId: inventoryPerm.id } });
    seniorRoleId = seniorRole.id;

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
    seniorToken = await makeUser(SENIOR_PHONE, seniorRole.id);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار الجرد', type: 'BRANCH' } });
    locationId = location.id;
    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة جرد', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 5 },
    });
    ingredientId = ingredient.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('blocks a user without inventory.adjust from creating a stocktake (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/stocktakes')
      .set(auth(noPermToken))
      .send({ locationId, lines: [{ ingredientId, countedQuantity: 10 }] });
    expect(res.status).toBe(403);
  });

  it('receives initial stock to count against', async () => {
    const res = await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId, ingredientId, quantity: 100, unitCost: 2 });
    expect(res.status).toBe(201);
  });

  let stocktake1Id: string;

  it('creates a stocktake snapshotting the current balance as systemQuantity', async () => {
    const res = await request(app.getHttpServer())
      .post('/stocktakes')
      .set(auth(adminToken))
      .send({ locationId, lines: [{ ingredientId, countedQuantity: 90 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(Number(res.body.lines[0].systemQuantity)).toBe(100);
    expect(Number(res.body.lines[0].variance)).toBe(-10);
    stocktake1Id = res.body.id;
  });

  it('auto-approves and applies a shrinkage when no Approval Matrix rule covers it', async () => {
    const res = await request(app.getHttpServer()).post(`/stocktakes/${stocktake1Id}/submit`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(90); // 100 - 10
  });

  it('rejects submitting a stocktake that is not IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer()).post(`/stocktakes/${stocktake1Id}/submit`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it('rejects editing lines on a stocktake that is not IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer())
      .put(`/stocktakes/${stocktake1Id}/lines`)
      .set(auth(adminToken))
      .send({ lines: [{ ingredientId, countedQuantity: 5 }] });
    expect(res.status).toBe(400);
  });

  let stocktake2Id: string;

  it('auto-approves and applies a phantom gain, pricing the new batch at the real weighted-average cost', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/stocktakes')
      .set(auth(adminToken))
      .send({ locationId, lines: [{ ingredientId, countedQuantity: 100 }] }); // system=90, variance=+10
    stocktake2Id = createRes.body.id;

    const submitRes = await request(app.getHttpServer()).post(`/stocktakes/${stocktake2Id}/submit`).set(auth(adminToken));
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('APPROVED');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(100); // 90 + 10

    const batch = await prisma.inventoryBatch.findFirst({ where: { sourceType: 'STOCKTAKE', sourceId: stocktake2Id } });
    expect(batch).not.toBeNull();
    expect(Number(batch!.unitCost)).toBe(2);
  });

  it('configures an Approval Matrix rule: STOCKTAKE_ADJUSTMENT over 15 SAR needs the senior role', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval-rules')
      .set(auth(adminToken))
      .send({ documentType: 'STOCKTAKE_ADJUSTMENT', maxAmount: 15, requiredRoleId: seniorRoleId });
    expect(res.status).toBe(201);
  });

  let stocktake3Id: string;

  it('a variance over the threshold goes to PENDING_APPROVAL instead of auto-applying', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/stocktakes')
      .set(auth(adminToken))
      .send({ locationId, lines: [{ ingredientId, countedQuantity: 70 }] }); // system=100, variance=-30, value=60
    stocktake3Id = createRes.body.id;

    const submitRes = await request(app.getHttpServer()).post(`/stocktakes/${stocktake3Id}/submit`).set(auth(adminToken));
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('PENDING_APPROVAL');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(100); // untouched
  });

  it('rejects approval from someone who holds inventory.adjust but not the matrix-required role (403)', async () => {
    const res = await request(app.getHttpServer()).post(`/stocktakes/${stocktake3Id}/approve`).set(auth(juniorToken));
    expect(res.status).toBe(403);
  });

  it('approves as the specific role the matrix requires, applying the adjustment', async () => {
    const res = await request(app.getHttpServer())
      .post(`/stocktakes/${stocktake3Id}/approve`)
      .set(auth(seniorToken))
      .send({ note: 'فاقد مبرر -- تلف مسجّل' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(70); // 100 - 30

    const approval = await prisma.approval.findFirst({ where: { stocktakeId: stocktake3Id } });
    expect(approval?.decision).toBe('APPROVED');
  });

  let stocktake4Id: string;

  it('rejecting a pending stocktake sends it back to IN_PROGRESS untouched, recording the decision', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/stocktakes')
      .set(auth(adminToken))
      .send({ locationId, lines: [{ ingredientId, countedQuantity: 40 }] }); // system=70, variance=-30, value=60
    stocktake4Id = createRes.body.id;
    await request(app.getHttpServer()).post(`/stocktakes/${stocktake4Id}/submit`).set(auth(adminToken));

    const rejectRes = await request(app.getHttpServer())
      .post(`/stocktakes/${stocktake4Id}/reject`)
      .set(auth(seniorToken))
      .send({ note: 'العدّ غير دقيق -- أعد الجرد' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('IN_PROGRESS');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(70); // untouched

    const approval = await prisma.approval.findFirst({ where: { stocktakeId: stocktake4Id, decision: 'REJECTED' } });
    expect(approval).not.toBeNull();
  });

  it('recounting refreshes systemQuantity from the CURRENT balance, not the stale one from creation', async () => {
    // Shift the balance in between: 70 -> 90.
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId, ingredientId, quantity: 20, unitCost: 2 });

    const res = await request(app.getHttpServer())
      .put(`/stocktakes/${stocktake4Id}/lines`)
      .set(auth(adminToken))
      .send({ lines: [{ ingredientId, countedQuantity: 85 }] });
    expect(res.status).toBe(200);
    expect(Number(res.body.lines[0].systemQuantity)).toBe(90); // fresh, not the original 70
    expect(Number(res.body.lines[0].variance)).toBe(-5);
  });

  it('resubmitting the recounted stocktake still requires approval (still within the matrix tier) and applies once approved', async () => {
    const submitRes = await request(app.getHttpServer()).post(`/stocktakes/${stocktake4Id}/submit`).set(auth(adminToken));
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('PENDING_APPROVAL');

    const approveRes = await request(app.getHttpServer()).post(`/stocktakes/${stocktake4Id}/approve`).set(auth(seniorToken));
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(85); // 90 - 5
  });

  it('a zero-variance count auto-approves immediately regardless of the configured rule', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/stocktakes')
      .set(auth(adminToken))
      .send({ locationId, lines: [{ ingredientId, countedQuantity: 85 }] }); // matches current balance exactly
    const id = createRes.body.id;

    const submitRes = await request(app.getHttpServer()).post(`/stocktakes/${id}/submit`).set(auth(adminToken));
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('APPROVED');

    const approval = await prisma.approval.findFirst({ where: { stocktakeId: id } });
    expect(approval).toBeNull(); // nothing needed deciding
  });

  it('lists and reads back stocktakes scoped to their location', async () => {
    const listRes = await request(app.getHttpServer()).get(`/stocktakes?locationId=${locationId}`).set(auth(adminToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(5);

    const getRes = await request(app.getHttpServer()).get(`/stocktakes/${stocktake3Id}`).set(auth(adminToken));
    expect(getRes.status).toBe(200);
    expect(getRes.body.lines).toHaveLength(1);
    expect(getRes.body.approvals).toHaveLength(1);
  });
});
