import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IngredientKind } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 2: ingredients (raw + semi-finished with their OWN recipe) and menu
// items (with a recipe referencing either kind) -- the multi-level BOM
// docs/DECISIONS.md decision #4 calls for. Runs against a real app + a
// real Postgres test database, same as the Phase 1 suite.
describe('Phase 2: ingredients + items + multi-level recipes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let adminUserId: string;

  const ADMIN_PHONE = '+966500000010';
  const ADMIN_PASSWORD = 'AdminPass123';
  const NOPERM_PHONE = '+966500000011';

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
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['Admin-Recipes-Test', 'Recipes-Test-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['ingredients.manage', 'items.manage', 'ingredients.view'] } } });

    const ingredientsPerm = await prisma.permission.create({
      data: { code: 'ingredients.manage', label: 'إدارة الأصناف' },
    });
    const itemsPerm = await prisma.permission.create({ data: { code: 'items.manage', label: 'إدارة المنيو' } });
    // Needed for GET /ingredients/:id/recipe below.
    const ingredientsViewPerm = await prisma.permission.create({ data: { code: 'ingredients.view', label: 'عرض المواد الخام ووصفاتها وتكلفتها' } });
    const role = await prisma.role.create({ data: { name: 'Admin-Recipes-Test' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: ingredientsPerm.id },
        { roleId: role.id, permissionId: itemsPerm.id },
        { roleId: role.id, permissionId: ingredientsViewPerm.id },
      ],
    });
    const noPermRole = await prisma.role.create({ data: { name: 'Recipes-Test-NoPerm' } });
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    adminUserId = admin.id;
    const noPermUser = await prisma.user.create({ data: { name: 'NoPerm', phone: NOPERM_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: noPermUser.id, roleId: noPermRole.id } });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.accessToken;

    const noPermLoginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: NOPERM_PHONE, password: ADMIN_PASSWORD });
    noPermToken = noPermLoginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string = adminToken) => ({ Authorization: `Bearer ${token}` });

  it('creates a raw material ingredient', async () => {
    const res = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth())
      .send({ name: 'طماطم', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 500 });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe(IngredientKind.RAW_MATERIAL);
  });

  it('rejects setting a recipe on a RAW_MATERIAL ingredient', async () => {
    const raw = await prisma.ingredient.create({
      data: { name: 'ملح', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 100 },
    });
    const salt2 = await prisma.ingredient.create({
      data: { name: 'ملح 2', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 100 },
    });
    const res = await request(app.getHttpServer())
      .put(`/ingredients/${raw.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: salt2.id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('builds a multi-level BOM: sauce (semi-finished, made from tomato+salt) used inside pizza (menu item)', async () => {
    const tomato = await prisma.ingredient.create({
      data: { name: 'طماطم للصلصة', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 500 },
    });
    const salt = await prisma.ingredient.create({
      data: { name: 'ملح للصلصة', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 100 },
    });
    const sauceRes = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth())
      .send({ name: 'صلصة طماطم جاهزة', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 200 });
    expect(sauceRes.status).toBe(201);
    const sauceId = sauceRes.body.id;

    const setSauceRecipeRes = await request(app.getHttpServer())
      .put(`/ingredients/${sauceId}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: tomato.id, quantity: 800 }, { ingredientId: salt.id, quantity: 20 }] });
    expect(setSauceRecipeRes.status).toBe(200);
    expect(setSauceRecipeRes.body).toHaveLength(2);

    const pizzaRes = await request(app.getHttpServer())
      .post('/items')
      .set(auth())
      .send({ name: 'بيتزا مارجريتا', category: 'رئيسي', price: 35 });
    expect(pizzaRes.status).toBe(201);
    const pizzaId = pizzaRes.body.id;

    const setPizzaRecipeRes = await request(app.getHttpServer())
      .put(`/items/${pizzaId}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: sauceId, quantity: 150 }] });
    expect(setPizzaRecipeRes.status).toBe(200);
    expect(setPizzaRecipeRes.body[0].ingredient.id).toBe(sauceId);

    const getRecipeRes = await request(app.getHttpServer()).get(`/items/${pizzaId}/recipe`).set(auth());
    expect(getRecipeRes.status).toBe(200);
    expect(getRecipeRes.body).toHaveLength(1);
    expect(getRecipeRes.body[0].ingredient.kind).toBe(IngredientKind.SEMI_FINISHED);
  });

  it('rejects a self-referencing recipe line', async () => {
    const semi = await prisma.ingredient.create({
      data: { name: 'صنف يشير لنفسه', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });
    const res = await request(app.getHttpServer())
      .put(`/ingredients/${semi.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: semi.id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('rejects a recipe referencing a non-existent ingredient id', async () => {
    const semi = await prisma.ingredient.create({
      data: { name: 'صنف باختبار مكوّن وهمي', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });
    const res = await request(app.getHttpServer())
      .put(`/ingredients/${semi.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: 'does-not-exist', quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('rejects a two-hop cycle (A depends on B, then B tries to depend on A)', async () => {
    const a = await prisma.ingredient.create({
      data: { name: 'دورة أ', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });
    const b = await prisma.ingredient.create({
      data: { name: 'دورة ب', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });

    const setARes = await request(app.getHttpServer())
      .put(`/ingredients/${a.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: b.id, quantity: 1 }] });
    expect(setARes.status).toBe(200);

    // B trying to depend on A now would close a cycle: A -> B -> A.
    const setBRes = await request(app.getHttpServer())
      .put(`/ingredients/${b.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: a.id, quantity: 1 }] });
    expect(setBRes.status).toBe(400);
  });

  it('rejects a deeper 3-hop cycle (A -> B -> C, then C tries to depend on A)', async () => {
    const a = await prisma.ingredient.create({
      data: { name: '3hop أ', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });
    const b = await prisma.ingredient.create({
      data: { name: '3hop ب', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });
    const c = await prisma.ingredient.create({
      data: { name: '3hop ج', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });

    await request(app.getHttpServer())
      .put(`/ingredients/${a.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: b.id, quantity: 1 }] });
    await request(app.getHttpServer())
      .put(`/ingredients/${b.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: c.id, quantity: 1 }] });

    const setCRes = await request(app.getHttpServer())
      .put(`/ingredients/${c.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: a.id, quantity: 1 }] });
    expect(setCRes.status).toBe(400);
  });

  it('replacing a recipe with an empty line list clears it', async () => {
    const raw = await prisma.ingredient.create({
      data: { name: 'مكوّن للحذف', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 100 },
    });
    const semi = await prisma.ingredient.create({
      data: { name: 'صنف هيتصفر', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
    });
    await request(app.getHttpServer())
      .put(`/ingredients/${semi.id}/recipe`)
      .set(auth())
      .send({ lines: [{ ingredientId: raw.id, quantity: 1 }] });

    const clearRes = await request(app.getHttpServer())
      .put(`/ingredients/${semi.id}/recipe`)
      .set(auth())
      .send({ lines: [] });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body).toHaveLength(0);

    const getRes = await request(app.getHttpServer()).get(`/ingredients/${semi.id}/recipe`).set(auth());
    expect(getRes.body).toHaveLength(0);
  });

  it('blocks changing unit once the ingredient has any inventory batch (movement)', async () => {
    const ingredient = await prisma.ingredient.create({
      data: { name: 'صنف له حركة مخزنية', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    const location = await prisma.location.create({ data: { name: 'فرع اختبار قفل الوحدة', type: 'BRANCH' } });
    await prisma.inventoryBatch.create({
      data: { locationId: location.id, ingredientId: ingredient.id, batchNumber: 'B-TEST-1', quantity: 10, unitCost: 5, sourceType: 'PURCHASE' },
    });

    const res = await request(app.getHttpServer())
      .patch(`/ingredients/${ingredient.id}`)
      .set(auth())
      .send({ unit: 'g' });
    expect(res.status).toBe(400);

    const stillSame = await prisma.ingredient.findUnique({ where: { id: ingredient.id } });
    expect(stillSame?.unit).toBe('kg');
  });

  it('allows changing unit freely when the ingredient has no inventory batches yet', async () => {
    const ingredient = await prisma.ingredient.create({
      data: { name: 'صنف بدون حركة مخزنية', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });

    const res = await request(app.getHttpServer())
      .patch(`/ingredients/${ingredient.id}`)
      .set(auth())
      .send({ unit: 'g' });
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe('g');
  });

  describe('PATCH /ingredients/:id/convert-unit', () => {
    it('rescales every dependent quantity/cost when converting gram -> kg', async () => {
      // the ingredient in its OWN role as a component (as a child recipe
      // line) and as the parent of its own BOM, at the same time, so both
      // rescale directions get exercised in one fixture.
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف تحويل جرام لكجم', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 2000, openingCost: 0.02 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار تحويل الوحدة 1', type: 'BRANCH' } });
      const batch = await prisma.inventoryBatch.create({
        data: { locationId: location.id, ingredientId: ingredient.id, batchNumber: 'B-CONV-1', quantity: 5000, unitCost: 0.03, sourceType: 'PURCHASE' },
      });
      const movement = await prisma.stockMovement.create({
        data: { batchId: batch.id, quantity: -200, reason: 'WASTE' },
      });
      await prisma.inventoryBalance.create({
        data: { ingredientId: ingredient.id, locationId: location.id, quantity: 4800 },
      });

      // ingredient used as a CHILD component in someone else's recipe
      const otherSemi = await prisma.ingredient.create({
        data: { name: 'صنف أب يستخدم صنف التحويل', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 100 },
      });
      const asChildLine = await prisma.recipeLine.create({
        data: { parentIngredientId: otherSemi.id, ingredientId: ingredient.id, quantity: 300 },
      });

      // ingredient's OWN BOM (it's the parent) -- a component measured in
      // an unrelated unit, whose own quantity must NOT be touched.
      const rawComponent = await prisma.ingredient.create({
        data: { name: 'مكوّن خام لصنف التحويل', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 50 },
      });
      const ownBomLine = await prisma.recipeLine.create({
        data: { parentIngredientId: ingredient.id, ingredientId: rawComponent.id, quantity: 400 },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe('كجم');
      expect(Number(res.body.lowStockThreshold)).toBeCloseTo(2, 6);
      expect(Number(res.body.openingCost)).toBeCloseTo(20, 6);

      const refreshedBatch = await prisma.inventoryBatch.findUnique({ where: { id: batch.id } });
      expect(Number(refreshedBatch?.quantity)).toBeCloseTo(5, 6);
      expect(Number(refreshedBatch?.unitCost)).toBeCloseTo(30, 6);

      const refreshedMovement = await prisma.stockMovement.findUnique({ where: { id: movement.id } });
      expect(Number(refreshedMovement?.quantity)).toBeCloseTo(-0.2, 6);

      const refreshedBalance = await prisma.inventoryBalance.findFirst({ where: { ingredientId: ingredient.id, locationId: location.id } });
      expect(Number(refreshedBalance?.quantity)).toBeCloseTo(4.8, 6);

      const refreshedChildLine = await prisma.recipeLine.findUnique({ where: { id: asChildLine.id } });
      expect(Number(refreshedChildLine?.quantity)).toBeCloseTo(0.3, 6);

      const refreshedOwnBomLine = await prisma.recipeLine.findUnique({ where: { id: ownBomLine.id } });
      expect(Number(refreshedOwnBomLine?.quantity)).toBeCloseTo(400000, 6);
    });

    it('rescales in the inverse direction when converting kg -> gram', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف تحويل كجم لجرام', unit: 'كجم', kind: 'RAW_MATERIAL', lowStockThreshold: 2, openingCost: 20 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار تحويل الوحدة 2', type: 'BRANCH' } });
      const batch = await prisma.inventoryBatch.create({
        data: { locationId: location.id, ingredientId: ingredient.id, batchNumber: 'B-CONV-2', quantity: 5, unitCost: 30, sourceType: 'PURCHASE' },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'جم' });
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe('جم');
      expect(Number(res.body.lowStockThreshold)).toBeCloseTo(2000, 6);
      expect(Number(res.body.openingCost)).toBeCloseTo(0.02, 6);

      const refreshedBatch = await prisma.inventoryBatch.findUnique({ where: { id: batch.id } });
      expect(Number(refreshedBatch?.quantity)).toBeCloseTo(5000, 6);
      expect(Number(refreshedBatch?.unitCost)).toBeCloseTo(0.03, 6);
    });

    it('rejects a conversion between units that are not in the same family (mass/volume/count)', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بوحدة غير مدعومة', unit: 'لتر', kind: 'RAW_MATERIAL', lowStockThreshold: 1 },
      });
      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(400);
    });

    it('relabels a same-family, same-magnitude unit spelling with no math at all (factor 1)', async () => {
      // "كجم" and "kg" are the exact same real unit, just spelled
      // differently -- a pure rename an admin needs after standardizing
      // free-text unit spellings, not an actual quantity change.
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بتسمية وحدة مختلفة لنفس الكيلوجرام', unit: 'كجم', kind: 'RAW_MATERIAL', lowStockThreshold: 3, openingCost: 12 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار إعادة تسمية الوحدة', type: 'BRANCH' } });
      const batch = await prisma.inventoryBatch.create({
        data: { locationId: location.id, ingredientId: ingredient.id, batchNumber: 'B-RELABEL-1', quantity: 7, unitCost: 15, sourceType: 'PURCHASE' },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'kg' });
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe('kg');
      expect(Number(res.body.lowStockThreshold)).toBeCloseTo(3, 6);
      expect(Number(res.body.openingCost)).toBeCloseTo(12, 6);

      const refreshedBatch = await prisma.inventoryBatch.findUnique({ where: { id: batch.id } });
      expect(Number(refreshedBatch?.quantity)).toBeCloseTo(7, 6);
      expect(Number(refreshedBatch?.unitCost)).toBeCloseTo(15, 6);
    });

    it('relabels a same-family count unit spelling ("حبة" -> "pcs") with no math', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بتسمية وحدة مختلفة لنفس القطعة', unit: 'حبة', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
      });
      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'pcs' });
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe('pcs');
      expect(Number(res.body.lowStockThreshold)).toBeCloseTo(10, 6);
    });

    it('rescales milliliter -> liter, the same mechanism as gram -> kg extended to the volume family', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف تحويل مليلتر للتر', unit: 'ml', kind: 'RAW_MATERIAL', lowStockThreshold: 500 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار تحويل الحجم', type: 'BRANCH' } });
      const batch = await prisma.inventoryBatch.create({
        data: { locationId: location.id, ingredientId: ingredient.id, batchNumber: 'B-CONV-VOL-1', quantity: 2000, unitCost: 0.01, sourceType: 'PURCHASE' },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'l' });
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe('l');
      expect(Number(res.body.lowStockThreshold)).toBeCloseTo(0.5, 6);

      const refreshedBatch = await prisma.inventoryBatch.findUnique({ where: { id: batch.id } });
      expect(Number(refreshedBatch?.quantity)).toBeCloseTo(2, 6);
      expect(Number(refreshedBatch?.unitCost)).toBeCloseTo(10, 6);
    });

    it('blocks conversion when a PLANNED production order consumes the ingredient as an input', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بأمر إنتاج معلق كمدخل', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 1 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار حظر 1', type: 'BRANCH' } });
      const outputIngredient = await prisma.ingredient.create({
        data: { name: 'ناتج أمر إنتاج الحظر 1', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 1 },
      });
      const order = await prisma.productionOrder.create({
        data: { locationId: location.id, outputIngredientId: outputIngredient.id, outputQuantity: 10, status: 'PLANNED' },
      });
      await prisma.productionOrderLine.create({
        data: { productionOrderId: order.id, ingredientId: ingredient.id, quantity: 5 },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(400);
    });

    it('blocks conversion when the ingredient is the (non-terminal) output of a production order', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف ناتج أمر إنتاج معلق', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 1 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار حظر 2', type: 'BRANCH' } });
      await prisma.productionOrder.create({
        data: { locationId: location.id, outputIngredientId: ingredient.id, outputQuantity: 10, status: 'IN_PROGRESS' },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(400);
    });

    it('blocks conversion when a non-terminal purchase order references the ingredient', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بأمر شراء معلق', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 1 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار حظر 3', type: 'BRANCH' } });
      const supplier = await prisma.supplier.create({ data: { name: 'مورد اختبار حظر التحويل' } });
      const purchaseOrder = await prisma.purchaseOrder.create({
        data: { locationId: location.id, supplierId: supplier.id, status: 'DRAFT', totalAmount: 100, createdById: adminUserId },
      });
      await prisma.purchaseOrderLine.create({
        data: { purchaseOrderId: purchaseOrder.id, ingredientId: ingredient.id, quantity: 10, unitCost: 5 },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(400);
    });

    it('blocks conversion when a DISPATCHED transfer references the ingredient', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بتحويل مخزني معلق', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 1 },
      });
      const fromLocation = await prisma.location.create({ data: { name: 'فرع مصدر اختبار حظر التحويل', type: 'BRANCH' } });
      const toLocation = await prisma.location.create({ data: { name: 'فرع وجهة اختبار حظر التحويل', type: 'BRANCH' } });
      const transfer = await prisma.transfer.create({
        data: { fromLocationId: fromLocation.id, toLocationId: toLocation.id, status: 'DISPATCHED' },
      });
      await prisma.transferLine.create({
        data: { transferId: transfer.id, ingredientId: ingredient.id, quantitySent: 10 },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(400);
    });

    it('blocks conversion when an open stocktake references the ingredient', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف بجرد معلق', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 1 },
      });
      const location = await prisma.location.create({ data: { name: 'فرع اختبار حظر الجرد', type: 'BRANCH' } });
      const stocktake = await prisma.stocktake.create({ data: { locationId: location.id, status: 'IN_PROGRESS' } });
      await prisma.stocktakeLine.create({
        data: { stocktakeId: stocktake.id, ingredientId: ingredient.id, systemQuantity: 10, countedQuantity: 9, variance: -1 },
      });

      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth())
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(400);
    });

    it('rejects the request without ingredients.manage permission (403)', async () => {
      const ingredient = await prisma.ingredient.create({
        data: { name: 'صنف اختبار صلاحية التحويل', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 1 },
      });
      const res = await request(app.getHttpServer())
        .patch(`/ingredients/${ingredient.id}/convert-unit`)
        .set(auth(noPermToken))
        .send({ toUnit: 'كجم' });
      expect(res.status).toBe(403);
    });
  });
});
