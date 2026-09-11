import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 6: Production Orders -- consumes raw/semi-finished inputs and
// produces a new batch of a semi-finished ingredient, reusing
// InventoryService.consume/receive exactly like Sales and Purchasing do
// (docs/ARCHITECTURE.md's shared inventory integration point). Runs
// against a real app + a real Postgres test database, same as every
// other suite.
describe('Phase 6: production orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let locationId: string;
  let tomatoId: string;
  let saltId: string;
  let sauceId: string;
  let noRecipeSemiId: string;

  const ADMIN_PHONE = '+966500000040';
  const NOPERM_PHONE = '+966500000041';
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
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: 'Production-Test-Admin' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['production.manage', 'inventory.adjust'] } } });

    const productionPerm = await prisma.permission.create({ data: { code: 'production.manage', label: 'إدارة أوامر الإنتاج' } });
    // Also needed to seed raw-material stock via /inventory/adjustments
    // before this suite's own production orders can consume anything.
    const inventoryPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    // analytics.view is global/shared with several other suites -- upsert
    // rather than create so it doesn't collide with its unique `code`
    // regardless of which suite runs first against this shared test DB.
    const analyticsPerm = await prisma.permission.upsert({
      where: { code: 'analytics.view' },
      update: {},
      create: { code: 'analytics.view', label: 'عرض التحليلات' },
    });
    const role = await prisma.role.create({ data: { name: 'Production-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [productionPerm, inventoryPerm, analyticsPerm].map((p) => ({ roleId: role.id, permissionId: p.id })),
    });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const location = await prisma.location.create({ data: { name: 'مطبخ مركزي -- اختبار إنتاج', type: 'CENTRAL_KITCHEN' } });
    locationId = location.id;

    const tomato = await prisma.ingredient.create({
      data: { name: 'طماطم إنتاج', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    tomatoId = tomato.id;
    const salt = await prisma.ingredient.create({
      data: { name: 'ملح إنتاج', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    saltId = salt.id;

    const sauce = await prisma.ingredient.create({
      data: { name: 'صلصة إنتاج', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 10 },
    });
    sauceId = sauce.id;
    // per-1-gram-of-sauce recipe: 8g tomato + 0.2g salt.
    await prisma.recipeLine.createMany({
      data: [
        { parentIngredientId: sauceId, ingredientId: tomatoId, quantity: 8 },
        { parentIngredientId: sauceId, ingredientId: saltId, quantity: 0.2 },
      ],
    });

    const noRecipeSemi = await prisma.ingredient.create({
      data: { name: 'نصف مصنّع بلا وصفة', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 10 },
    });
    noRecipeSemiId = noRecipeSemi.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('blocks a user without production.manage from creating a production order (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(noPermToken))
      .send({ locationId, outputIngredientId: sauceId, outputQuantity: 100 });
    expect(res.status).toBe(403);
  });

  it('rejects a production order for a RAW_MATERIAL output', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: tomatoId, outputQuantity: 10 });
    expect(res.status).toBe(400);
  });

  it('rejects auto-deriving lines when the output ingredient has no recipe registered', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: noRecipeSemiId, outputQuantity: 10 });
    expect(res.status).toBe(400);
  });

  let mainPoId: string;

  it('creates a production order auto-deriving input lines from the recipe, scaled by outputQuantity', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: sauceId, outputQuantity: 100 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PLANNED');
    const byIngredient = (id: string) => res.body.inputs.find((l: any) => l.ingredientId === id);
    expect(Number(byIngredient(tomatoId).quantity)).toBe(800);
    expect(Number(byIngredient(saltId).quantity)).toBe(20);
    mainPoId = res.body.id;
  });

  it('rejects starting when the location has no stock yet (nothing is consumed)', async () => {
    const res = await request(app.getHttpServer()).post(`/production-orders/${mainPoId}/start`).set(auth(adminToken));
    expect(res.status).toBe(400);

    const getRes = await request(app.getHttpServer()).get(`/production-orders/${mainPoId}`).set(auth(adminToken));
    expect(getRes.body.status).toBe('PLANNED');
  });

  it('receives raw material stock to work with', async () => {
    const tomatoRes = await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId, ingredientId: tomatoId, quantity: 1000, unitCost: 1 });
    expect(tomatoRes.status).toBe(201);
    const saltRes = await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId, ingredientId: saltId, quantity: 100, unitCost: 5 });
    expect(saltRes.status).toBe(201);
  });

  it('blocks a user without production.manage from starting (403)', async () => {
    const res = await request(app.getHttpServer()).post(`/production-orders/${mainPoId}/start`).set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  it('starts the order, consuming both inputs atomically and capturing their real cost', async () => {
    const res = await request(app.getHttpServer()).post(`/production-orders/${mainPoId}/start`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
    // 800g tomato @1 + 20g salt @5 = 900
    expect(Number(res.body.totalInputCost)).toBe(900);

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const balanceOf = (id: string) => Number(balances.body.find((b: any) => b.ingredientId === id).quantity);
    expect(balanceOf(tomatoId)).toBe(200); // 1000 - 800
    expect(balanceOf(saltId)).toBe(80); // 100 - 20
  });

  it('completes the order, producing a real batch priced at cost/outputQuantity', async () => {
    const res = await request(app.getHttpServer()).post(`/production-orders/${mainPoId}/complete`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    const sauceBalance = balances.body.find((b: any) => b.ingredientId === sauceId);
    expect(Number(sauceBalance.quantity)).toBe(100);

    const batch = await prisma.inventoryBatch.findFirst({ where: { sourceType: 'PRODUCTION', sourceId: mainPoId } });
    expect(batch).not.toBeNull();
    expect(Number(batch!.unitCost)).toBe(9); // 900 total cost / 100g output
  });

  it('rejects completing an already-COMPLETED order', async () => {
    const res = await request(app.getHttpServer()).post(`/production-orders/${mainPoId}/complete`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  it('rejects cancelling a COMPLETED order', async () => {
    const res = await request(app.getHttpServer()).post(`/production-orders/${mainPoId}/cancel`).set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let overrideePoId: string;

  it('creates a production order with an explicit line override instead of the recipe', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: sauceId, outputQuantity: 10, lines: [{ ingredientId: tomatoId, quantity: 50 }] });
    expect(res.status).toBe(201);
    expect(res.body.inputs).toHaveLength(1);
    expect(Number(res.body.inputs[0].quantity)).toBe(50);
    overrideePoId = res.body.id;
  });

  it('cancelling an IN_PROGRESS order restocks exactly what it consumed', async () => {
    const startRes = await request(app.getHttpServer()).post(`/production-orders/${overrideePoId}/start`).set(auth(adminToken));
    expect(startRes.status).toBe(200);

    const midBalances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(midBalances.body.find((b: any) => b.ingredientId === tomatoId).quantity)).toBe(150); // 200 - 50

    const cancelRes = await request(app.getHttpServer()).post(`/production-orders/${overrideePoId}/cancel`).set(auth(adminToken));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const afterBalances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(afterBalances.body.find((b: any) => b.ingredientId === tomatoId).quantity)).toBe(200); // restored
  });

  it('cancelling a PLANNED order (never started) touches no inventory', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: sauceId, outputQuantity: 5 });
    const plannedId = createRes.body.id;

    const cancelRes = await request(app.getHttpServer()).post(`/production-orders/${plannedId}/cancel`).set(auth(adminToken));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === tomatoId).quantity)).toBe(200);
  });

  it('lists production orders scoped to their location', async () => {
    const res = await request(app.getHttpServer()).get(`/production-orders?locationId=${locationId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('production-summary reports real consumed cost for the completed order, and 0-cost PLANNED orders are excluded', async () => {
    const res = await request(app.getHttpServer())
      .get('/analytics/production-summary')
      .query({ locationId })
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.totalCost).toBeGreaterThanOrEqual(900); // mainPoId alone already cost 900
    const sauceRow = res.body.byOutput.find((o: any) => o.name === 'صلصة إنتاج');
    expect(sauceRow).toBeDefined();
    expect(sauceRow.totalCost).toBeGreaterThanOrEqual(900);
    expect(sauceRow.avgUnitCost).toBeGreaterThan(0);
  });
});
