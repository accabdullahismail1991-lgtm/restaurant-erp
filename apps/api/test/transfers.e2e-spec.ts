import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 7: Transfers -- dispatch consumes the source location atomically
// and captures the real cost of what left; receive credits the
// destination with exactly what arrived at that same cost, and any
// shortfall between quantitySent and quantityReceived is transit loss
// (docs/DECISIONS.md #6), a fact derived from the two stored quantities
// rather than a separate ledger entry. Runs against a real app + a real
// Postgres test database, same as every other suite.
describe('Phase 7: transfers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;
  let scopedElsewhereToken: string;
  let locationAId: string;
  let locationBId: string;
  let locationCId: string;
  let ingredientId: string;

  const ADMIN_PHONE = '+966500000050';
  const NOPERM_PHONE = '+966500000051';
  const ELSEWHERE_PHONE = '+966500000052';
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
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE, ELSEWHERE_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: 'Transfers-Test-Admin' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['transfers.manage', 'inventory.adjust'] } } });

    const transfersPerm = await prisma.permission.create({ data: { code: 'transfers.manage', label: 'إدارة التحويلات' } });
    // Also needed to seed source stock via /inventory/adjustments.
    const inventoryPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const role = await prisma.role.create({ data: { name: 'Transfers-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [transfersPerm, inventoryPerm].map((p) => ({ roleId: role.id, permissionId: p.id })),
    });

    const makeUser = async (phone: string, roleId?: string, scopeLocationId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      if (scopeLocationId) await prisma.userLocationScope.create({ data: { userId: user.id, locationId: scopeLocationId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };

    const locationA = await prisma.location.create({ data: { name: 'فرع تحويل أ', type: 'BRANCH' } });
    locationAId = locationA.id;
    const locationB = await prisma.location.create({ data: { name: 'فرع تحويل ب', type: 'BRANCH' } });
    locationBId = locationB.id;
    const locationC = await prisma.location.create({ data: { name: 'فرع تحويل خارج النطاق', type: 'BRANCH' } });
    locationCId = locationC.id;

    adminToken = await makeUser(ADMIN_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);
    scopedElsewhereToken = await makeUser(ELSEWHERE_PHONE, role.id, locationCId);

    const ingredient = await prisma.ingredient.create({
      data: { name: 'طماطم تحويل', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    ingredientId = ingredient.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('blocks a user without transfers.manage from dispatching a transfer (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/transfers')
      .set(auth(noPermToken))
      .send({ fromLocationId: locationAId, toLocationId: locationBId, lines: [{ ingredientId, quantity: 10 }] });
    expect(res.status).toBe(403);
  });

  it('rejects a transfer where the source and destination are the same location', async () => {
    const res = await request(app.getHttpServer())
      .post('/transfers')
      .set(auth(adminToken))
      .send({ fromLocationId: locationAId, toLocationId: locationAId, lines: [{ ingredientId, quantity: 10 }] });
    expect(res.status).toBe(400);
  });

  it('rejects dispatching when the source has no stock yet', async () => {
    const res = await request(app.getHttpServer())
      .post('/transfers')
      .set(auth(adminToken))
      .send({ fromLocationId: locationAId, toLocationId: locationBId, lines: [{ ingredientId, quantity: 10 }] });
    expect(res.status).toBe(400);
  });

  it('receives source stock to work with', async () => {
    const res = await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId: locationAId, ingredientId, quantity: 1000, unitCost: 3 });
    expect(res.status).toBe(201);
  });

  let transfer1Id: string;

  it('dispatches a transfer, consuming the source atomically and capturing the real unit cost', async () => {
    const res = await request(app.getHttpServer())
      .post('/transfers')
      .set(auth(adminToken))
      .send({ fromLocationId: locationAId, toLocationId: locationBId, lines: [{ ingredientId, quantity: 400 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DISPATCHED');
    expect(Number(res.body.lines[0].unitCost)).toBe(3);
    transfer1Id = res.body.id;

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationAId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(600); // 1000 - 400
  });

  it('blocks a user without transfers.manage from receiving (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/transfers/${transfer1Id}/receive`)
      .set(auth(noPermToken))
      .send({ lines: [{ ingredientId, quantityReceived: 400 }] });
    expect(res.status).toBe(403);
  });

  it('rejects receiving more than what was sent', async () => {
    const res = await request(app.getHttpServer())
      .post(`/transfers/${transfer1Id}/receive`)
      .set(auth(adminToken))
      .send({ lines: [{ ingredientId, quantityReceived: 500 }] });
    expect(res.status).toBe(400);
  });

  it('receives a partial quantity, recording it as RECEIVED_WITH_VARIANCE (transit loss)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/transfers/${transfer1Id}/receive`)
      .set(auth(adminToken))
      .send({ lines: [{ ingredientId, quantityReceived: 380 }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RECEIVED_WITH_VARIANCE');
    expect(Number(res.body.lines[0].quantityReceived)).toBe(380);

    const balances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationBId}`).set(auth(adminToken));
    expect(Number(balances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(380);

    const batch = await prisma.inventoryBatch.findFirst({ where: { sourceType: 'TRANSFER', sourceId: transfer1Id } });
    expect(Number(batch!.unitCost)).toBe(3); // carried over from the source's real cost
  });

  it('rejects receiving an already-received transfer again', async () => {
    const res = await request(app.getHttpServer())
      .post(`/transfers/${transfer1Id}/receive`)
      .set(auth(adminToken))
      .send({ lines: [{ ingredientId, quantityReceived: 20 }] });
    expect(res.status).toBe(400);
  });

  let transfer2Id: string;

  it('dispatches and fully receives a second transfer with no shortfall -> plain RECEIVED', async () => {
    const dispatchRes = await request(app.getHttpServer())
      .post('/transfers')
      .set(auth(adminToken))
      .send({ fromLocationId: locationAId, toLocationId: locationBId, lines: [{ ingredientId, quantity: 600 }] });
    expect(dispatchRes.status).toBe(201);
    transfer2Id = dispatchRes.body.id;

    const receiveRes = await request(app.getHttpServer())
      .post(`/transfers/${transfer2Id}/receive`)
      .set(auth(adminToken))
      .send({ lines: [{ ingredientId, quantityReceived: 600 }] });
    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('RECEIVED');

    const sourceBalances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationAId}`).set(auth(adminToken));
    expect(Number(sourceBalances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(0); // 600 - 600

    const destBalances = await request(app.getHttpServer()).get(`/inventory/balances?locationId=${locationBId}`).set(auth(adminToken));
    expect(Number(destBalances.body.find((b: any) => b.ingredientId === ingredientId).quantity)).toBe(980); // 380 + 600
  });

  it('blocks a user scoped to an unrelated location from viewing a transfer between two other locations (403)', async () => {
    const res = await request(app.getHttpServer()).get(`/transfers/${transfer1Id}`).set(auth(scopedElsewhereToken));
    expect(res.status).toBe(403);
  });

  it('lists transfers filtered to either end of the location', async () => {
    const res = await request(app.getHttpServer()).get(`/transfers?locationId=${locationBId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});
