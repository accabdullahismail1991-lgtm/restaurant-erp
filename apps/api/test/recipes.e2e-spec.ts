import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IngredientKind } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Phase 2: ingredients (raw + semi-finished with their OWN recipe) and menu
// items (with a recipe referencing either kind) -- the multi-level BOM
// docs/DECISIONS.md decision #4 calls for. Runs against a real app + a
// real Postgres test database, same as the Phase 1 suite.
describe('Phase 2: ingredients + items + multi-level recipes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const ADMIN_PHONE = '+966500000010';
  const ADMIN_PASSWORD = 'AdminPass123';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    // Defensively clears other suites' tables that FK into
    // Ingredient/MenuItem before deleting those -- this suite runs after
    // purchasing.e2e-spec.ts alphabetically (PurchaseOrderLine AND
    // InventoryBatch, created on receive, both FK to Ingredient) and
    // leftover Order/OrderLine rows from a previous run's
    // sales.e2e-spec.ts FK to MenuItem, any of which would otherwise
    // break this suite's own cleanup.
    await prisma.approval.deleteMany({});
    await prisma.purchaseOrderLine.deleteMany({});
    await prisma.purchaseOrder.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.orderLine.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.stockMovement.deleteMany({});
    await prisma.inventoryBatch.deleteMany({});
    await prisma.inventoryBalance.deleteMany({});
    await prisma.recipeLine.deleteMany({});
    await prisma.menuItem.deleteMany({});
    await prisma.ingredient.deleteMany({});
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });
    await prisma.role.deleteMany({ where: { name: 'Admin-Recipes-Test' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['ingredients.manage', 'items.manage'] } } });

    const ingredientsPerm = await prisma.permission.create({
      data: { code: 'ingredients.manage', label: 'إدارة الأصناف' },
    });
    const itemsPerm = await prisma.permission.create({ data: { code: 'items.manage', label: 'إدارة المنيو' } });
    const role = await prisma.role.create({ data: { name: 'Admin-Recipes-Test' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: ingredientsPerm.id },
        { roleId: role.id, permissionId: itemsPerm.id },
      ],
    });
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

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
});
