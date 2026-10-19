import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 1 verification ("report-architecture" session): the reporting
// catalog's data dictionary described menu-item-costs as exploding a
// multi-level BOM live, recursively, through a SEMI_FINISHED ingredient's
// own recipe. The actual implementation (menuItemCostsCore,
// analytics.service.ts) does NOT do that -- it reads the semi-finished
// ingredient's own real InventoryBatch cost directly, the same as any raw
// material, falling back to its openingCost only when it has never been
// produced. The "explosion" happens exactly once, at production time
// (ProductionOrdersService.start()/complete()), baked permanently into the
// produced batch's cost -- not recomputed live on every report. This test
// pins that real, intentional behavior (see the comment above
// menuItemCostsCore) so the catalog's description can be corrected to match
// reality instead of the other way around.
describe('Menu item costing through a multi-level BOM (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;

  const PHONE = '+966500000340';
  const PASSWORD = 'MultiLevelBomTest123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
    await prisma.role.deleteMany({ where: { name: 'MultiLevelBom-Test-Role' } });
    const permCodes = [
      'ingredients.view', 'ingredients.manage', 'inventory.view', 'inventory.adjust',
      'analytics.view', 'items.manage', 'production.view', 'production.manage',
    ];
    await prisma.permission.deleteMany({ where: { code: { in: permCodes } } });

    const perms = await Promise.all(permCodes.map((code) => prisma.permission.create({ data: { code, label: code } })));
    const role = await prisma.role.create({ data: { name: 'MultiLevelBom-Test-Role' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار BOM متعدد المستويات', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses the sub-recipe\'s openingCost before production, then its real produced-batch cost after', async () => {
    const h = auth(token);
    const api = request(app.getHttpServer());

    // Level 0 raw materials.
    const tomato = (await api.post('/ingredients').set(h).send({ name: 'طماطم BOM', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 })).body;
    const salt = (await api.post('/ingredients').set(h).send({ name: 'ملح BOM', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 })).body;
    await api.post('/inventory/adjustments').set(h).send({ locationId, ingredientId: tomato.id, quantity: 10, unitCost: 2.0 });
    await api.post('/inventory/adjustments').set(h).send({ locationId, ingredientId: salt.id, quantity: 2, unitCost: 1.0 });

    // Level 1: a SEMI_FINISHED sub-recipe (sauce), never produced yet --
    // only an openingCost placeholder.
    const sauce = (await api.post('/ingredients').set(h).send({
      name: 'صلصة BOM', unit: 'kg', kind: 'SEMI_FINISHED', lowStockThreshold: 0, openingCost: 0.5,
    })).body;
    await api.put(`/ingredients/${sauce.id}/recipe`).set(h).send({
      lines: [{ ingredientId: tomato.id, quantity: 0.9 }, { ingredientId: salt.id, quantity: 0.1 }],
    });

    // Level 2: the menu item, 0.2 kg of sauce per unit.
    const pizza = (await api.post('/items').set(h).send({ name: 'بيتزا BOM', category: 'اختبار', price: 50 })).body;
    await api.put(`/items/${pizza.id}/recipe`).set(h).send({ lines: [{ ingredientId: sauce.id, quantity: 0.2 }] });

    // --- Before production: falls back to the sauce's openingCost. ---
    const before = await api.get(`/analytics/menu-item-costs?locationId=${locationId}`).set(h);
    const rowBefore = before.body.find((r: { menuItemId: string }) => r.menuItemId === pizza.id);
    expect(rowBefore.cost).toBe(0.1); // 0.2 kg * 0.5/kg opening cost
    expect(rowBefore.costIsEstimated).toBe(true);

    // --- Produce 1kg of sauce: consumes 0.9kg tomato (@2.00=1.80) + 0.1kg
    // salt (@1.00=0.10) = 1.90 total input cost -> 1.90/kg produced. ---
    const po = (await api.post('/production-orders').set(h).send({ locationId, outputIngredientId: sauce.id, outputQuantity: 1 })).body;
    await api.post(`/production-orders/${po.id}/start`).set(h);
    await api.post(`/production-orders/${po.id}/complete`).set(h);

    // --- After production: the menu item's cost now reflects the sauce's
    // REAL produced-batch cost, not a live recompute from current raw
    // ingredient prices (which is exactly the batch's basis right now
    // anyway, but the point is WHICH number it reads). ---
    const after = await api.get(`/analytics/menu-item-costs?locationId=${locationId}`).set(h);
    const rowAfter = after.body.find((r: { menuItemId: string }) => r.menuItemId === pizza.id);
    expect(rowAfter.cost).toBe(0.38); // 0.2 kg * 1.90/kg real produced cost
    expect(rowAfter.costIsEstimated).toBe(false);

    // Raising the tomato price AFTER the sauce was produced must NOT move
    // the sauce's already-produced batch cost, and therefore must not move
    // the pizza's cost either -- confirms the explosion is baked in at
    // production time, not re-derived live from current raw prices.
    await api.post('/inventory/adjustments').set(h).send({ locationId, ingredientId: tomato.id, quantity: 10, unitCost: 9.0 });
    const afterPriceHike = await api.get(`/analytics/menu-item-costs?locationId=${locationId}`).set(h);
    const rowAfterHike = afterPriceHike.body.find((r: { menuItemId: string }) => r.menuItemId === pizza.id);
    expect(rowAfterHike.cost).toBe(0.38);
  });
});
