import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// The "🔄 تحديث تكلفة كل الأصناف" refresh: a SEMI_FINISHED ingredient's cost
// should be recomputed from its recipe's CURRENT component prices, even
// overriding a stale cost left over from its last actual production run --
// while a RAW_MATERIAL that already has real purchase batches is left
// completely alone (its own batches are already the live truth).
describe('Ingredient cost recompute (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;

  const PHONE = '+966500000180';
  const PASSWORD = 'RecomputeTest123';
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
    await prisma.role.deleteMany({ where: { name: 'Recompute-Test-Role' } });
    await prisma.permission.deleteMany({
      where: { code: { in: ['ingredients.view', 'ingredients.manage', 'inventory.view', 'inventory.adjust'] } },
    });

    const perms = await Promise.all(
      ['ingredients.view', 'ingredients.manage', 'inventory.view', 'inventory.adjust'].map((code) =>
        prisma.permission.create({ data: { code, label: code } }),
      ),
    );
    const role = await prisma.role.create({ data: { name: 'Recompute-Test-Role' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار إعادة الحساب', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('recomputes a SEMI_FINISHED ingredient from its recipe, overriding its stale batch cost, and leaves RAW_MATERIAL batches untouched', async () => {
    // Two raw components, one priced via a real batch, one via openingCost only.
    const flour = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth(token))
      .send({ name: 'دقيق اختبار إعادة الحساب', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 });
    const sugar = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth(token))
      .send({ name: 'سكر اختبار إعادة الحساب', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0, openingCost: 1 });

    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId: flour.body.id, quantity: 100, unitCost: 2 });

    // Semi-finished item, recipe: 2kg flour (cost 2/kg) + 1kg sugar (cost 1/kg) = 5.
    const dough = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth(token))
      .send({ name: 'عجينة اختبار إعادة الحساب', unit: 'kg', kind: 'SEMI_FINISHED', lowStockThreshold: 0, openingCost: 3 });
    await request(app.getHttpServer())
      .put(`/ingredients/${dough.body.id}/recipe`)
      .set(auth(token))
      .send({ lines: [{ ingredientId: flour.body.id, quantity: 2 }, { ingredientId: sugar.body.id, quantity: 1 }] });

    // First run: dough has no batch yet -> its stale openingCost (3) should become 5 via openingCost.
    const res1 = await request(app.getHttpServer()).post('/ingredients/recompute-costs').set(auth(token));
    expect(res1.status).toBe(200);
    const doughUpdate1 = res1.body.updated.find((u: { ingredientId: string }) => u.ingredientId === dough.body.id);
    expect(doughUpdate1).toBeDefined();
    expect(doughUpdate1.action).toBe('openingCost');
    expect(doughUpdate1.previousCost).toBe(3);
    expect(doughUpdate1.newCost).toBe(5);
    const flourAfter1 = res1.body.updated.find((u: { ingredientId: string }) => u.ingredientId === flour.body.id);
    expect(flourAfter1).toBeUndefined(); // RAW_MATERIAL with a real batch -- left alone

    const doughAfterRun1 = await request(app.getHttpServer()).get(`/ingredients/${dough.body.id}`).set(auth(token));
    expect(Number(doughAfterRun1.body.openingCost)).toBe(5);

    // Simulate a real production run that baked in a STALE cost (3/kg) into an actual batch.
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId: dough.body.id, quantity: 20, unitCost: 3 });

    // Raw flour price goes up from 2 -> 4/kg (a real new purchase would normally do this;
    // for the test we just correct the existing batch directly) -- dough's recipe cost is now 4*2+1*1=9.
    await request(app.getHttpServer())
      .post('/inventory/cost-adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId: flour.body.id, newUnitCost: 4 });

    const res2 = await request(app.getHttpServer()).post('/ingredients/recompute-costs').set(auth(token));
    expect(res2.status).toBe(200);
    const doughUpdate2 = res2.body.updated.find((u: { ingredientId: string }) => u.ingredientId === dough.body.id);
    expect(doughUpdate2).toBeDefined();
    expect(doughUpdate2.action).toBe('costAdjustment');
    expect(doughUpdate2.previousCost).toBe(3); // its stale production-time batch cost
    expect(doughUpdate2.newCost).toBe(9); // recomputed from the recipe's current component prices
    expect(doughUpdate2.locationsUpdated).toBe(1);

    const doughBatch = await prisma.inventoryBatch.findFirst({ where: { ingredientId: dough.body.id } });
    expect(Number(doughBatch!.unitCost)).toBe(9);

    const flourBatch = await prisma.inventoryBatch.findFirst({ where: { ingredientId: flour.body.id } });
    expect(Number(flourBatch!.unitCost)).toBe(4); // untouched by recompute, still whatever the real batch says
  });

  it('blocks recompute without inventory.adjust (403)', async () => {
    const NOPERM_PHONE = '+966500000181';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const res = await request(app.getHttpServer())
      .post('/ingredients/recompute-costs')
      .set(auth(loginRes.body.accessToken));
    expect(res.status).toBe(403);
  });
});
