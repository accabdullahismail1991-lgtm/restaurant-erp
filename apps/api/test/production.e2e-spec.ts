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
    await prisma.permission.deleteMany({ where: { code: { in: ['production.manage', 'inventory.adjust', 'inventory.view'] } } });

    const productionPerm = await prisma.permission.create({ data: { code: 'production.manage', label: 'إدارة أوامر الإنتاج' } });
    // Also needed to seed raw-material stock via /inventory/adjustments
    // before this suite's own production orders can consume anything.
    const inventoryPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    // Needed for GET /inventory/balances below.
    const inventoryViewPerm2 = await prisma.permission.create({ data: { code: 'inventory.view', label: 'عرض أرصدة المخزون وحركاته' } });
    // analytics.view is global/shared with several other suites -- upsert
    // rather than create so it doesn't collide with its unique `code`
    // regardless of which suite runs first against this shared test DB.
    const analyticsPerm = await prisma.permission.upsert({
      where: { code: 'analytics.view' },
      update: {},
      create: { code: 'analytics.view', label: 'عرض التحليلات' },
    });
    // Needed for GET /production-orders and GET /production-orders/:id below
    // -- also global/shared, same upsert reasoning as analytics.view.
    const productionViewPerm = await prisma.permission.upsert({
      where: { code: 'production.view' },
      update: {},
      create: { code: 'production.view', label: 'عرض أوامر الإنتاج' },
    });
    const role = await prisma.role.create({ data: { name: 'Production-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [productionPerm, inventoryPerm, analyticsPerm, productionViewPerm, inventoryViewPerm2].map((p) => ({ roleId: role.id, permissionId: p.id })),
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

  // Any ingredient can be the output now -- a RAW_MATERIAL (or a
  // SEMI_FINISHED item with no recipe of its own, tested right below)
  // just gets an empty inputs list, a plain "produce/restock N more"
  // note with no consumption to track. See production-orders.service.ts's
  // create()/applyShortfall() comments for why this isn't rejected --
  // most real menus are built mostly on raw ingredients, not multi-step
  // BOMs, and a manager should still be able to log "made N more of X"
  // for one of those.
  it('creates a production order for a RAW_MATERIAL output with an empty inputs list', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: tomatoId, outputQuantity: 10 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PLANNED');
    expect(res.body.inputs).toHaveLength(0);
  });

  // An empty inputs list must still go through start()/complete() cleanly
  // -- nothing to consume (0 cost captured), and the output batch still
  // gets received at that 0 cost rather than crashing on a divide-by-zero
  // or an empty consume loop. A dedicated ingredient here (not tomatoId)
  // -- completing this PO adds stock of its OWN output ingredient, which
  // would otherwise throw off the exact tomato-balance numbers the rest
  // of this suite tracks below.
  it('starts and completes a production order with an empty inputs list, producing a 0-cost batch', async () => {
    const bread = await prisma.ingredient.create({
      data: { name: 'خبز -- اختبار إنتاج بلا مدخلات', unit: 'قطعة', kind: 'RAW_MATERIAL', lowStockThreshold: 5 },
    });
    const createRes = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: bread.id, outputQuantity: 3 });
    const poId = createRes.body.id;

    const startRes = await request(app.getHttpServer()).post(`/production-orders/${poId}/start`).set(auth(adminToken));
    expect(startRes.status).toBe(200);
    expect(startRes.body.status).toBe('IN_PROGRESS');
    expect(Number(startRes.body.totalInputCost)).toBe(0);

    const completeRes = await request(app.getHttpServer()).post(`/production-orders/${poId}/complete`).set(auth(adminToken));
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('COMPLETED');

    const batch = await prisma.inventoryBatch.findFirst({ where: { sourceType: 'PRODUCTION', sourceId: poId } });
    expect(batch).not.toBeNull();
    expect(Number(batch!.quantity)).toBe(3);
    expect(Number(batch!.unitCost)).toBe(0);
  });

  it('creates a production order with an empty inputs list when the SEMI_FINISHED output has no recipe registered', async () => {
    const res = await request(app.getHttpServer())
      .post('/production-orders')
      .set(auth(adminToken))
      .send({ locationId, outputIngredientId: noRecipeSemiId, outputQuantity: 10 });
    expect(res.status).toBe(201);
    expect(res.body.inputs).toHaveLength(0);
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

  // POST /production-orders/process-ready -- the bulk "some of the
  // shortage is stocked now, finish whatever can be finished" action a
  // manager reaches for after a delivery arrives, instead of clicking
  // start+complete one PLANNED order at a time. A dedicated
  // location/ingredients here, not locationId/tomatoId/sauceId above --
  // this location already has two leftover PLANNED empty-inputs orders
  // from earlier tests that were deliberately never advanced (to prove
  // they aren't rejected), and process-ready would sweep those up too
  // (they always succeed -- nothing to wait on), throwing off this
  // block's own exact counts if it shared that location.
  describe('POST /production-orders/process-ready', () => {
    let readyLocationId: string;
    let flourId: string;
    let pastaId: string;
    let poReadyA: string;
    let poReadyB: string;

    it('sets up a dedicated location + a SEMI_FINISHED output with a real BOM', async () => {
      const location = await prisma.location.create({ data: { name: 'فرع اختبار تشغيل الجاهز', type: 'BRANCH' } });
      readyLocationId = location.id;
      const flour = await prisma.ingredient.create({ data: { name: 'دقيق اختبار الجاهز', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 } });
      flourId = flour.id;
      const pasta = await prisma.ingredient.create({ data: { name: 'عجين اختبار الجاهز', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 10 } });
      pastaId = pasta.id;
      // per-1g-of-pasta recipe: 5g flour.
      await prisma.recipeLine.create({ data: { parentIngredientId: pastaId, ingredientId: flourId, quantity: 5 } });
    });

    it('blocks a user without production.manage from calling it (403)', async () => {
      const res = await request(app.getHttpServer()).post('/production-orders/process-ready').set(auth(noPermToken));
      expect(res.status).toBe(403);
    });

    it('creates two PLANNED orders (50g flour each) with no flour in stock yet', async () => {
      const resA = await request(app.getHttpServer())
        .post('/production-orders')
        .set(auth(adminToken))
        .send({ locationId: readyLocationId, outputIngredientId: pastaId, outputQuantity: 10 });
      expect(resA.status).toBe(201);
      poReadyA = resA.body.id;

      const resB = await request(app.getHttpServer())
        .post('/production-orders')
        .set(auth(adminToken))
        .send({ locationId: readyLocationId, outputIngredientId: pastaId, outputQuantity: 10 });
      expect(resB.status).toBe(201);
      poReadyB = resB.body.id;
    });

    it('with zero stock, leaves both orders PLANNED -- nothing consumed', async () => {
      const res = await request(app.getHttpServer())
        .post('/production-orders/process-ready')
        .set(auth(adminToken))
        .query({ locationId: readyLocationId });
      expect(res.status).toBe(200);
      expect(res.body.completedCount).toBe(0);
      expect(res.body.stillShortCount).toBe(2);

      const getA = await request(app.getHttpServer()).get(`/production-orders/${poReadyA}`).set(auth(adminToken));
      expect(getA.body.status).toBe('PLANNED');
    });

    it('with only enough flour for ONE order, finishes the older order first and leaves the other short', async () => {
      const receiveRes = await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set(auth(adminToken))
        .send({ locationId: readyLocationId, ingredientId: flourId, quantity: 50, unitCost: 2 });
      expect(receiveRes.status).toBe(201);

      const res = await request(app.getHttpServer())
        .post('/production-orders/process-ready')
        .set(auth(adminToken))
        .query({ locationId: readyLocationId });
      expect(res.status).toBe(200);
      expect(res.body.completedCount).toBe(1);
      expect(res.body.stillShortCount).toBe(1);
      const resultA = res.body.results.find((r: any) => r.id === poReadyA);
      const resultB = res.body.results.find((r: any) => r.id === poReadyB);
      expect(resultA.completed).toBe(true);
      expect(resultB.completed).toBe(false);
      expect(typeof resultB.reason).toBe('string');

      const getA = await request(app.getHttpServer()).get(`/production-orders/${poReadyA}`).set(auth(adminToken));
      expect(getA.body.status).toBe('COMPLETED');
      const getB = await request(app.getHttpServer()).get(`/production-orders/${poReadyB}`).set(auth(adminToken));
      expect(getB.body.status).toBe('PLANNED');

      const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${readyLocationId}`).set(auth(adminToken));
      expect(Number(balances.body.find((b: any) => b.ingredientId === pastaId).quantity)).toBe(10); // only order A's output so far
      expect(Number(balances.body.find((b: any) => b.ingredientId === flourId).quantity)).toBe(0); // fully consumed by order A
    });

    it('once the rest of the flour arrives, finishes the remaining order too', async () => {
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set(auth(adminToken))
        .send({ locationId: readyLocationId, ingredientId: flourId, quantity: 50, unitCost: 2 });

      const res = await request(app.getHttpServer())
        .post('/production-orders/process-ready')
        .set(auth(adminToken))
        .query({ locationId: readyLocationId });
      expect(res.body.completedCount).toBe(1);
      expect(res.body.stillShortCount).toBe(0);

      const getB = await request(app.getHttpServer()).get(`/production-orders/${poReadyB}`).set(auth(adminToken));
      expect(getB.body.status).toBe('COMPLETED');
    });

    it('also finishes an empty-inputs PLANNED order (RAW_MATERIAL "restock" alert) regardless of stock', async () => {
      const rawNoInputs = await prisma.ingredient.create({
        data: { name: 'صنف اختبار بلا مدخلات للجاهز', unit: 'قطعة', kind: 'RAW_MATERIAL', lowStockThreshold: 5 },
      });
      const createRes = await request(app.getHttpServer())
        .post('/production-orders')
        .set(auth(adminToken))
        .send({ locationId: readyLocationId, outputIngredientId: rawNoInputs.id, outputQuantity: 4 });
      expect(createRes.body.inputs).toHaveLength(0);

      const res = await request(app.getHttpServer())
        .post('/production-orders/process-ready')
        .set(auth(adminToken))
        .query({ locationId: readyLocationId });
      expect(res.body.completedCount).toBe(1);
      expect(res.body.stillShortCount).toBe(0);

      const getRes = await request(app.getHttpServer()).get(`/production-orders/${createRes.body.id}`).set(auth(adminToken));
      expect(getRes.body.status).toBe('COMPLETED');
    });

    it('with nothing left PLANNED, is a no-op', async () => {
      const res = await request(app.getHttpServer())
        .post('/production-orders/process-ready')
        .set(auth(adminToken))
        .query({ locationId: readyLocationId });
      expect(res.body.completedCount).toBe(0);
      expect(res.body.stillShortCount).toBe(0);
      expect(res.body.results).toHaveLength(0);
    });
  });
});
