import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase H: purchase returns -- the mirror of customer Returns (Phase C) in
// the opposite inventory direction, only ever against a purchase order
// that was actually RECEIVED (goods really entered inventory then).
// Refund amount is computed from the PO line's own unitCost, not a
// blended inventory average, since it's what's owed back BY that supplier.
describe('Purchase returns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manageToken: string;
  let noPermToken: string;
  let locationId: string;
  let ingredientId: string;
  let supplierId: string;

  const MANAGE_PHONE = '+966500000200';
  const NOPERM_PHONE = '+966500000201';
  const PASSWORD = 'PurchReturnTest123';

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
    await prisma.user.deleteMany({ where: { phone: { in: [MANAGE_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['PReturns-Test-Manager', 'PReturns-Test-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: { in: ['purchasing.return_po', 'purchasing.create_po'] } } });

    const returnPerm = await prisma.permission.create({ data: { code: 'purchasing.return_po', label: 'تسجيل مرتجع لمورد' } });
    const createPoPerm = await prisma.permission.create({ data: { code: 'purchasing.create_po', label: 'إنشاء أوامر شراء' } });
    const role = await prisma.role.create({ data: { name: 'PReturns-Test-Manager' } });
    await prisma.rolePermission.createMany({
      data: [returnPerm, createPoPerm].map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    await prisma.role.create({ data: { name: 'PReturns-Test-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    manageToken = await makeUser(MANAGE_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار مرتجعات المشتريات', type: 'BRANCH' } });
    locationId = location.id;
    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة اختبار مرتجعات مشتريات', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 5 },
    });
    ingredientId = ingredient.id;
    const supplier = await prisma.supplier.create({ data: { name: 'مورد اختبار مرتجعات' } });
    supplierId = supplier.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createReceivedPO(quantity: number, unitCost: number) {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(manageToken))
      .send({ locationId, supplierId, lines: [{ ingredientId, quantity, unitCost }] });
    expect(createRes.status).toBe(201);
    const poId = createRes.body.id;
    const submitRes = await request(app.getHttpServer()).post(`/purchase-orders/${poId}/submit`).set(auth(manageToken));
    expect(submitRes.body.status).toBe('APPROVED'); // no Approval Matrix rule configured -- auto-approved
    const receiveRes = await request(app.getHttpServer()).post(`/purchase-orders/${poId}/receive`).set(auth(manageToken));
    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('RECEIVED');
    return { poId, lineId: receiveRes.body.lines[0].id as string };
  }

  it('rejects returnable-lines and create for a PO that has not been RECEIVED yet (still DRAFT)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set(auth(manageToken))
      .send({ locationId, supplierId, lines: [{ ingredientId, quantity: 10, unitCost: 5 }] });
    const draftPoId = createRes.body.id;

    const returnableRes = await request(app.getHttpServer())
      .get(`/purchase-returns/order/${draftPoId}/returnable-lines`)
      .set(auth(manageToken));
    expect(returnableRes.status).toBe(400);

    const createReturnRes = await request(app.getHttpServer())
      .post('/purchase-returns')
      .set(auth(manageToken))
      .send({ purchaseOrderId: draftPoId, lines: [{ purchaseOrderLineId: createRes.body.lines[0].id, quantity: 1 }] });
    expect(createReturnRes.status).toBe(400);
  });

  it('blocks creating a purchase return without purchasing.return_po (403)', async () => {
    const { poId, lineId } = await createReceivedPO(10, 5);
    const res = await request(app.getHttpServer())
      .post('/purchase-returns')
      .set(auth(noPermToken))
      .send({ purchaseOrderId: poId, lines: [{ purchaseOrderLineId: lineId, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it('returnable-lines reports the full received quantity before any return', async () => {
    const { poId, lineId } = await createReceivedPO(10, 5);
    const res = await request(app.getHttpServer()).get(`/purchase-returns/order/${poId}/returnable-lines`).set(auth(manageToken));
    expect(res.status).toBe(200);
    const line = res.body.find((l: { purchaseOrderLineId: string }) => l.purchaseOrderLineId === lineId);
    expect(Number(line.quantity)).toBe(10);
    expect(line.alreadyReturned).toBe(0);
    expect(line.remaining).toBe(10);
  });

  it('creates a partial return, computes totalAmount from the PO line unitCost, and depletes inventory', async () => {
    const { poId, lineId } = await createReceivedPO(10, 5); // 10kg @ 5 = 50
    const balanceBefore = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });

    const res = await request(app.getHttpServer())
      .post('/purchase-returns')
      .set(auth(manageToken))
      .send({ purchaseOrderId: poId, reason: 'صنف تالف من المورد', lines: [{ purchaseOrderLineId: lineId, quantity: 4 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.totalAmount)).toBe(20); // 4 * 5
    expect(Number(res.body.lines[0].quantity)).toBe(4);

    const balanceAfter = await prisma.inventoryBalance.findUnique({ where: { ingredientId_locationId: { ingredientId, locationId } } });
    expect(Number(balanceBefore!.quantity) - Number(balanceAfter!.quantity)).toBe(4);

    const returnableRes = await request(app.getHttpServer()).get(`/purchase-returns/order/${poId}/returnable-lines`).set(auth(manageToken));
    const line = returnableRes.body.find((l: { purchaseOrderLineId: string }) => l.purchaseOrderLineId === lineId);
    expect(line.alreadyReturned).toBe(4);
    expect(line.remaining).toBe(6);
  });

  it('rejects returning more than what remains (cumulative across returns)', async () => {
    const { poId, lineId } = await createReceivedPO(5, 3);
    const first = await request(app.getHttpServer())
      .post('/purchase-returns')
      .set(auth(manageToken))
      .send({ purchaseOrderId: poId, lines: [{ purchaseOrderLineId: lineId, quantity: 3 }] });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/purchase-returns')
      .set(auth(manageToken))
      .send({ purchaseOrderId: poId, lines: [{ purchaseOrderLineId: lineId, quantity: 3 }] }); // only 2 remain
    expect(second.status).toBe(400);
  });

  it('lists purchase returns for the location, newest first, with PO + ingredient details', async () => {
    const res = await request(app.getHttpServer()).get('/purchase-returns').set(auth(manageToken)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].lines[0].purchaseOrderLine.ingredient.name).toBe('خامة اختبار مرتجعات مشتريات');
  });
});
