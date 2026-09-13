import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Menu engineering (Kasavana & Smith matrix): classifies every item
// actually sold in a period by popularity (its share of units sold) and
// profitability (its contribution margin vs. the period's own
// volume-weighted average) into STAR/PLOWHORSE/PUZZLE/DOG. This test
// deliberately engineers one real item into each of the four quadrants
// (fixed price=100 for all four, quantities and recipe costs chosen so the
// math lands exactly on the four classifications) rather than asserting on
// arbitrary numbers, so a real regression in the threshold/classification
// logic fails a concrete, human-checkable expectation.
describe('Menu engineering (Kasavana & Smith matrix) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewToken: string;
  let locationId: string;
  const ingredientIdByKey: Record<string, string> = {};

  const VIEW_PHONE = '+966500000140';
  const PASSWORD = 'MenuEngTest123';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: VIEW_PHONE } });
    await prisma.role.deleteMany({ where: { name: 'MenuEng-Test-Viewer' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'inventory.adjust'] } } });

    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const adjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const viewRole = await prisma.role.create({ data: { name: 'MenuEng-Test-Viewer' } });
    await prisma.rolePermission.createMany({ data: [viewPerm, adjustPerm].map((p) => ({ roleId: viewRole.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: VIEW_PHONE, phone: VIEW_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: viewRole.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: VIEW_PHONE, password: PASSWORD });
    viewToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار هندسة المنيو', type: 'BRANCH' } });
    locationId = location.id;

    // Four items, all priced at 100, differing only in recipe cost and
    // quantity sold -- exactly the two axes the matrix classifies on.
    const plan = [
      { key: 'star', qty: 40, cost: 20 },
      { key: 'plowhorse', qty: 40, cost: 90 },
      { key: 'puzzle', qty: 10, cost: 10 },
      { key: 'dog', qty: 10, cost: 95 },
    ];
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(viewToken)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    for (const p of plan) {
      const ingredient = await prisma.ingredient.create({ data: { name: `خامة ${p.key}`, unit: 'pcs', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
      ingredientIdByKey[p.key] = ingredient.id;
      const menuItem = await prisma.menuItem.create({ data: { name: `صنف ${p.key}`, category: 'اختبار', price: 100 } });
      await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 1 } });
      await request(app.getHttpServer())
        .post('/inventory/adjustments')
        .set(auth(viewToken))
        .send({ locationId, ingredientId: ingredient.id, quantity: 1000, unitCost: p.cost });

      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(viewToken))
        .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: p.qty }] });
      await request(app.getHttpServer())
        .post(`/orders/${orderRes.body.id}/pay`)
        .set(auth(viewToken))
        .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('classifies each engineered item into its expected quadrant', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/menu-engineering?locationId=${locationId}`).set(auth(viewToken));
    expect(res.status).toBe(200);

    // total qty = 100, popularity threshold = (1/4 items) * 0.7 = 17.5%
    expect(res.body.popularityThresholdPercent).toBe(17.5);
    // weighted avg margin = (80*40 + 10*40 + 90*10 + 5*10) / 100 = 45.5
    expect(res.body.avgMargin).toBe(45.5);
    expect(res.body.counts).toEqual({ STAR: 1, PLOWHORSE: 1, PUZZLE: 1, DOG: 1 });

    const byName = (name: string) => res.body.items.find((i: { name: string }) => i.name === name);
    expect(byName('صنف star')).toMatchObject({ quantity: 40, popularityPercent: 40, margin: 80, classification: 'STAR' });
    expect(byName('صنف plowhorse')).toMatchObject({ quantity: 40, popularityPercent: 40, margin: 10, classification: 'PLOWHORSE' });
    expect(byName('صنف puzzle')).toMatchObject({ quantity: 10, popularityPercent: 10, margin: 90, classification: 'PUZZLE' });
    expect(byName('صنف dog')).toMatchObject({ quantity: 10, popularityPercent: 10, margin: 5, classification: 'DOG' });
  });

  it('simulates a hypothetical ingredient cost change and reclassifies affected items', async () => {
    // Raising the "puzzle" ingredient's cost from 10 to 95 crashes that
    // item's margin from 90 to 5, which also drags the period's own
    // volume-weighted avg margin down from 45.5 to 37.0 -- low enough that
    // the item (still below the 17.5% popularity threshold) flips from
    // PUZZLE to DOG, while every other item's classification is unaffected.
    const res = await request(app.getHttpServer())
      .post('/analytics/cost-impact-simulation')
      .set(auth(viewToken))
      .send({ locationId, ingredientChanges: [{ ingredientId: ingredientIdByKey.puzzle, newUnitCost: 95 }] });
    expect(res.status).toBe(201);
    expect(res.body.classificationShiftCount).toBe(1);

    const byName = (name: string) => res.body.items.find((i: { name: string }) => i.name === name);
    expect(byName('صنف puzzle')).toMatchObject({
      currentCost: 10,
      simulatedCost: 95,
      costDelta: 85,
      currentMargin: 90,
      simulatedMargin: 5,
      marginDelta: -85,
      currentClassification: 'PUZZLE',
      simulatedClassification: 'DOG',
      classificationChanged: true,
    });
    expect(res.body.items.every((i: { menuItemId: string }) => i.menuItemId !== undefined)).toBe(true);
    expect(res.body.items.find((i: { name: string }) => i.name === 'صنف star')).toBeUndefined();
  });

  it('blocks without analytics.view (403)', async () => {
    const NOPERM_PHONE = '+966500000149';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const res = await request(app.getHttpServer()).get(`/analytics/menu-engineering?locationId=${locationId}`).set(auth(loginRes.body.accessToken));
    expect(res.status).toBe(403);

    const simRes = await request(app.getHttpServer())
      .post('/analytics/cost-impact-simulation')
      .set(auth(loginRes.body.accessToken))
      .send({ locationId, ingredientChanges: [{ ingredientId: ingredientIdByKey.puzzle, newUnitCost: 95 }] });
    expect(simRes.status).toBe(403);
  });
});
