import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// The inventory item card (Phase 1 reporting catalog, "report-architecture"
// session): a per-ingredient movement ledger with a running balance,
// independently derived from StockMovement rather than read off
// InventoryBalance, so the report can RECONCILE against it instead of just
// re-displaying the same number. See InventoryService.getItemCard.
describe('Inventory item card (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;

  const PHONE = '+966500000330';
  const PASSWORD = 'ItemCardTest123';
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
    await prisma.role.deleteMany({ where: { name: 'ItemCard-Test-Role' } });
    await prisma.permission.deleteMany({
      where: { code: { in: ['ingredients.view', 'ingredients.manage', 'inventory.view', 'inventory.adjust'] } },
    });

    const perms = await Promise.all(
      ['ingredients.view', 'ingredients.manage', 'inventory.view', 'inventory.adjust'].map((code) =>
        prisma.permission.create({ data: { code, label: code } }),
      ),
    );
    const role = await prisma.role.create({ data: { name: 'ItemCard-Test-Role' } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار بطاقة الصنف', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('computes a running balance that reconciles with InventoryBalance, in reason order, most recent first', async () => {
    const ing = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth(token))
      .send({ name: 'طماطم اختبار بطاقة الصنف', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 });
    const ingredientId = ing.body.id;

    // Receive 100 @ 4.00, then 50 more @ 5.00 (two batches, different
    // costs -- a real weighted-average scenario, not a single flat price).
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId, quantity: 100, unitCost: 4 });
    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(token))
      .send({ locationId, ingredientId, quantity: 50, unitCost: 5 });
    // Waste 12 (depletes the oldest/cheapest batch first, per consume()'s FIFO order).
    await request(app.getHttpServer())
      .post('/inventory/waste')
      .set(auth(token))
      .send({ locationId, ingredientId, quantity: 12 });

    const res = await request(app.getHttpServer())
      .get(`/inventory/ingredients/${ingredientId}/movements`)
      .query({ locationId })
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.ingredient.name).toBe('طماطم اختبار بطاقة الصنف');

    // 100 + 50 - 12 = 138, and it must match InventoryBalance exactly.
    expect(res.body.currentBalance).toBe(138);
    expect(res.body.storedBalance).toBe(138);
    expect(res.body.reconciled).toBe(true);

    expect(res.body.movements).toHaveLength(3);
    // Most recent first: the waste row leads, then the two receipts in
    // reverse chronological order -- each runningBalance is the true
    // cumulative total AS OF that row, not re-derived from a filtered window.
    expect(res.body.movements[0].reason).toBe('WASTE');
    expect(res.body.movements[0].quantity).toBe(-12);
    expect(res.body.movements[0].runningBalance).toBe(138);

    expect(res.body.movements[1].reason).toBe('MANUAL_ADJUSTMENT');
    expect(res.body.movements[1].quantity).toBe(50);
    expect(res.body.movements[1].unitCost).toBe(5);
    expect(res.body.movements[1].runningBalance).toBe(150);

    expect(res.body.movements[2].reason).toBe('MANUAL_ADJUSTMENT');
    expect(res.body.movements[2].quantity).toBe(100);
    expect(res.body.movements[2].unitCost).toBe(4);
    expect(res.body.movements[2].runningBalance).toBe(100);

    // Valuation uses the weighted-average cost across what's still open --
    // the waste depleted the cheaper batch first (FIFO in consume()), so
    // what's left is 88 @ 4.00 + 50 @ 5.00 = 352 + 250 = 602, / 138 ≈ 4.3623.
    expect(res.body.averageUnitCost).toBeCloseTo(602 / 138, 4);
    expect(res.body.valuation).toBeCloseTo(602, 2);
  });

  it('rejects a user whose location scope excludes the requested branch', async () => {
    const otherLocation = await prisma.location.create({ data: { name: 'فرع خارج النطاق', type: 'BRANCH' } });
    const ing = await request(app.getHttpServer())
      .post('/ingredients')
      .set(auth(token))
      .send({ name: 'صنف لاختبار النطاق', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 });

    // Scope this user to ONLY `locationId` (not `otherLocation`), by giving
    // them a UserLocationScope row -- same mechanism `scopedLocationIds()`
    // already reads for every other inventory endpoint.
    await prisma.user.deleteMany({ where: { phone: '+966500000331' } });
    const scopedUser = await prisma.user.create({
      data: { name: '+966500000331', phone: '+966500000331', passwordHash: await bcrypt.hash('ScopeTest123', 10) },
    });
    const role = await prisma.role.findFirstOrThrow({ where: { name: 'ItemCard-Test-Role' } });
    await prisma.userRole.create({ data: { userId: scopedUser.id, roleId: role.id } });
    await prisma.userLocationScope.create({ data: { userId: scopedUser.id, locationId } });
    const scopedLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: '+966500000331', password: 'ScopeTest123' });
    const scopedToken = scopedLogin.body.accessToken;

    const res = await request(app.getHttpServer())
      .get(`/inventory/ingredients/${ing.body.id}/movements`)
      .query({ locationId: otherLocation.id })
      .set(auth(scopedToken));

    expect(res.status).toBe(403);
  });
});
