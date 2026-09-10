import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase E: a unified alerts feed, entirely derived from existing tables --
// low stock (reuses AnalyticsService.lowStock), ingredients about to
// expire, and purchase orders/stocktakes waiting on the Approval Matrix.
// Runs against a real app + a real Postgres test database.
describe('Alerts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let userId: string;

  const PHONE = '+966500000170';
  const PASSWORD = 'AlertsTest123';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.user.deleteMany({ where: { phone: PHONE } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: 'Alerts Tester', phone: PHONE, passwordHash } });
    userId = user.id;
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار التنبيهات', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts with no alerts for a brand new location', async () => {
    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('surfaces a LOW_STOCK alert once a balance drops to/below its ingredient threshold', async () => {
    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة منخفضة للتنبيه', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 10 },
    });
    await prisma.inventoryBalance.create({ data: { ingredientId: ingredient.id, locationId, quantity: 5 } });

    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    const alert = res.body.find((a: { type: string }) => a.type === 'LOW_STOCK');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warning');
    expect(alert.title).toContain('خامة منخفضة للتنبيه');
  });

  it('surfaces an EXPIRING_BATCH alert for a batch expiring within the window, with danger severity when very close', async () => {
    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة قاربت الصلاحية', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    const soon = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h from now -- inside the danger threshold
    await prisma.inventoryBatch.create({
      data: {
        locationId,
        ingredientId: ingredient.id,
        batchNumber: 'ALERT-TEST-1',
        quantity: 20,
        unitCost: 3,
        sourceType: 'ADJUSTMENT',
        expiresAt: soon,
      },
    });

    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    const alert = res.body.find((a: { type: string }) => a.type === 'EXPIRING_BATCH');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('danger');
    expect(alert.title).toContain('خامة قاربت الصلاحية');
  });

  it('does NOT surface a batch expiring far in the future', async () => {
    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة صلاحيتها بعيدة', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    const farFuture = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days
    await prisma.inventoryBatch.create({
      data: {
        locationId,
        ingredientId: ingredient.id,
        batchNumber: 'ALERT-TEST-2',
        quantity: 20,
        unitCost: 3,
        sourceType: 'ADJUSTMENT',
        expiresAt: farFuture,
      },
    });

    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    const titles = res.body.map((a: { title: string }) => a.title);
    expect(titles.some((t: string) => t.includes('خامة صلاحيتها بعيدة'))).toBe(false);
  });

  it('surfaces a PO_PENDING_APPROVAL alert for a purchase order awaiting approval', async () => {
    const supplier = await prisma.supplier.create({ data: { name: 'مورد اختبار التنبيهات' } });
    await prisma.purchaseOrder.create({
      data: { locationId, supplierId: supplier.id, status: 'PENDING_APPROVAL', totalAmount: 500, createdById: userId },
    });

    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    const alert = res.body.find((a: { type: string }) => a.type === 'PO_PENDING_APPROVAL');
    expect(alert).toBeDefined();
    expect(alert.detail).toContain('مورد اختبار التنبيهات');
  });

  it('surfaces a STOCKTAKE_PENDING_APPROVAL alert for a stocktake awaiting approval', async () => {
    await prisma.stocktake.create({ data: { locationId, status: 'PENDING_APPROVAL' } });

    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    const alert = res.body.find((a: { type: string }) => a.type === 'STOCKTAKE_PENDING_APPROVAL');
    expect(alert).toBeDefined();
  });

  it('sorts danger before warning before info', async () => {
    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId });
    const severities = res.body.map((a: { severity: string }) => a.severity);
    const rank: Record<string, number> = { danger: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(rank[severities[i - 1]]);
    }
  });

  it('rejects a locationId outside the caller\'s scope (403) once scoped to a different location', async () => {
    const otherLocation = await prisma.location.create({ data: { name: 'فرع آخر خارج النطاق', type: 'BRANCH' } });
    await prisma.userLocationScope.create({ data: { userId, locationId: otherLocation.id } });

    const res = await request(app.getHttpServer()).get('/alerts').set(auth(token)).query({ locationId }); // still the original, now out of scope
    expect(res.status).toBe(403);

    await prisma.userLocationScope.deleteMany({ where: { userId } }); // restore unrestricted scope for any suite reusing this state
  });
});
