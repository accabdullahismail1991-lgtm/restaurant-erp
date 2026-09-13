import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Three standard restaurant/retail BI reports the user asked to have
// recommended and built: ABC/Pareto item analysis (classify items by
// cumulative revenue share -- A/B/C), sales-by-category mix, and a
// period-over-period comparison (current window vs the immediately
// preceding window of the same length). Engineers exact known quantities
// so every percentage/classification/percent-change can be verified.
describe('Standard analytical report suite: ABC, category mix, period comparison (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;

  const PHONE = '+966500000260';
  const PASSWORD = 'StdReportsTest123';
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
    await prisma.role.deleteMany({ where: { name: 'StdReports-Test' } });
    await prisma.permission.deleteMany({ where: { code: 'analytics.view' } });

    const perm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const role = await prisma.role.create({ data: { name: 'StdReports-Test' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: PHONE, phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار التقارير القياسية', type: 'BRANCH' } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('ABC analysis: classifies items by cumulative revenue share correctly', async () => {
    // 3 items, prices chosen so revenue is 800 / 150 / 50 out of 1000 total
    // -> cumulative 80% / 95% / 100% -- exactly on the A/B boundary and the
    // B/C boundary, a deliberate edge-case check (<=80 -> A, <=95 -> B).
    const itemA = await prisma.menuItem.create({ data: { name: 'صنف A', category: 'رئيسي', price: 800 } });
    const itemB = await prisma.menuItem.create({ data: { name: 'صنف B', category: 'رئيسي', price: 150 } });
    const itemC = await prisma.menuItem.create({ data: { name: 'صنف C', category: 'حلويات', price: 50 } });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;
    for (const item of [itemA, itemB, itemC]) {
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(token))
        .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: item.id, quantity: 1 }] });
      await request(app.getHttpServer())
        .post(`/orders/${orderRes.body.id}/pay`)
        .set(auth(token))
        .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    }

    const res = await request(app.getHttpServer()).get(`/analytics/abc-analysis?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(1000);
    const byName = (name: string) => res.body.items.find((i: { name: string }) => i.name === name);
    expect(byName('صنف A').class).toBe('A');
    expect(byName('صنف A').cumulativePercent).toBe(80);
    expect(byName('صنف B').class).toBe('B');
    expect(byName('صنف B').cumulativePercent).toBe(95);
    expect(byName('صنف C').class).toBe('C');
    expect(byName('صنف C').cumulativePercent).toBe(100);
    expect(res.body.summary).toEqual([
      { class: 'A', itemCount: 1, revenue: 800, revenuePercent: 80 },
      { class: 'B', itemCount: 1, revenue: 150, revenuePercent: 15 },
      { class: 'C', itemCount: 1, revenue: 50, revenuePercent: 5 },
    ]);

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(token)).send({ closingCounted: 100 });
  });

  it('category mix: groups revenue by menu category, not by item', async () => {
    const res = await request(app.getHttpServer()).get(`/analytics/category-mix?locationId=${locationId}`).set(auth(token));
    expect(res.status).toBe(200);
    // صنف A + صنف B are both "رئيسي" (800+150=950), صنف C alone is "حلويات" (50).
    const main = res.body.find((c: { category: string }) => c.category === 'رئيسي');
    const dessert = res.body.find((c: { category: string }) => c.category === 'حلويات');
    expect(main.revenue).toBe(950);
    expect(main.quantity).toBe(2);
    expect(dessert.revenue).toBe(50);
    expect(main.revenuePercent).toBe(95);
  });

  it('period comparison: current window vs the immediately preceding window of the same length', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // All 3 sales above happened "today" -- asking for today..today (a
    // 1-day window) means the "previous" window is exactly yesterday, where
    // nothing happened, so revenue goes from 0 to 1000 -> a clean +100%.
    const res = await request(app.getHttpServer())
      .get(`/analytics/period-comparison?locationId=${locationId}&from=${today}&to=${today}`)
      .set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.current.from).toBe(today);
    expect(res.body.current.to).toBe(today);
    expect(res.body.current.revenue).toBe(1150); // 1000 subtotal + 15% VAT
    expect(res.body.previous.revenue).toBe(0);
    expect(res.body.previous.orderCount).toBe(0);
    expect(res.body.change.revenue).toBe(100);
    expect(res.body.change.orderCount).toBe(100);

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    expect(res.body.previous.from).toBe(yesterday);
    expect(res.body.previous.to).toBe(yesterday);
  });

  it('blocks all three without analytics.view (403)', async () => {
    const NOPERM_PHONE = '+966500000261';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const noAuth = auth(loginRes.body.accessToken);
    for (const path of ['abc-analysis', 'category-mix', 'period-comparison']) {
      const res = await request(app.getHttpServer()).get(`/analytics/${path}?locationId=${locationId}`).set(noAuth);
      expect(res.status).toBe(403);
    }
  });
});
