import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase 10c: Customers/Loyalty -- closes the last piece of docs/DECISIONS.md
// #15 ("CRM + Loyalty مدمج... مع Points Ledger منفصل"). Customer.points
// stays a cached running total; LoyaltyTransaction is the actual ledger,
// same "ledger + cached aggregate" split as StockMovement/InventoryBalance.
// Runs against a real app + a real Postgres test database, same as every
// other suite.
describe('Phase 10c: customers / loyalty (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let menuItemId: string;
  let shiftId: string;

  const ADMIN_PHONE = '+966500000100';
  const PASSWORD = 'CustomerTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: 'Customer Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار العملاء', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار العملاء', category: 'رئيسي', price: 100 } });
    menuItemId = menuItem.id;

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const payFreshOrder = async (customerId?: string) => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', customerId, lines: [{ menuItemId, quantity: 1 }] });
    if (orderRes.status !== 201) return orderRes;
    const payRes = await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    return payRes;
  };

  it('creates a customer and rejects a duplicate phone (409)', async () => {
    const res = await request(app.getHttpServer()).post('/customers').set(auth(adminToken)).send({ name: 'أحمد', phone: '+966511110001' });
    expect(res.status).toBe(201);
    expect(res.body.points).toBe(0);

    const dupRes = await request(app.getHttpServer()).post('/customers').set(auth(adminToken)).send({ name: 'أحمد آخر', phone: '+966511110001' });
    expect(dupRes.status).toBe(409);
  });

  it('rejects creating an order with a customerId that does not exist', async () => {
    const res = await payFreshOrder('nonexistent-customer-id');
    expect(res.status).toBe(400);
  });

  it('never touches the loyalty ledger for an order with no customer', async () => {
    const before = await prisma.loyaltyTransaction.count();
    const res = await payFreshOrder(undefined);
    expect(res.status).toBe(200);
    const after = await prisma.loyaltyTransaction.count();
    expect(after).toBe(before);
  });

  it('awards floor(grandTotal / 10) points on payment, with a real ledger entry', async () => {
    const customerRes = await request(app.getHttpServer()).post('/customers').set(auth(adminToken)).send({ phone: '+966511110002' });
    const customerId = customerRes.body.id;

    const payRes = await payFreshOrder(customerId);
    expect(payRes.status).toBe(200);
    // subtotal 100, VAT 15% -> grandTotal 115 -> floor(115/10) = 11 points
    expect(Number(payRes.body.grandTotal)).toBe(115);

    const customerAfter = await request(app.getHttpServer()).get(`/customers/${customerId}`).set(auth(adminToken));
    expect(customerAfter.body.points).toBe(11);

    const ledgerRes = await request(app.getHttpServer()).get(`/customers/${customerId}/ledger`).set(auth(adminToken));
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body).toHaveLength(1);
    expect(ledgerRes.body[0].points).toBe(11);
    expect(ledgerRes.body[0].reason).toBe('ORDER_EARN');
    expect(ledgerRes.body[0].orderId).toBe(payRes.body.id);
  });

  it('accumulates points across multiple paid orders for the same customer', async () => {
    const customerRes = await request(app.getHttpServer()).post('/customers').set(auth(adminToken)).send({ phone: '+966511110003' });
    const customerId = customerRes.body.id;

    await payFreshOrder(customerId);
    await payFreshOrder(customerId);

    const customerAfter = await request(app.getHttpServer()).get(`/customers/${customerId}`).set(auth(adminToken));
    expect(customerAfter.body.points).toBe(22); // 11 + 11

    const ledgerRes = await request(app.getHttpServer()).get(`/customers/${customerId}/ledger`).set(auth(adminToken));
    expect(ledgerRes.body).toHaveLength(2);
  });

  it('redeems points within balance, decrementing points and recording a negative ledger entry', async () => {
    const customerRes = await request(app.getHttpServer()).post('/customers').set(auth(adminToken)).send({ phone: '+966511110004' });
    const customerId = customerRes.body.id;
    await payFreshOrder(customerId); // 11 points

    const redeemRes = await request(app.getHttpServer()).post(`/customers/${customerId}/redeem`).set(auth(adminToken)).send({ points: 5 });
    expect(redeemRes.status).toBe(200);
    expect(redeemRes.body.pointsRedeemed).toBe(5);
    expect(redeemRes.body.cashValue).toBeCloseTo(0.5, 2); // 5 points * 0.10
    expect(redeemRes.body.customer.points).toBe(6); // 11 - 5

    const ledgerRes = await request(app.getHttpServer()).get(`/customers/${customerId}/ledger`).set(auth(adminToken));
    const redeemEntry = ledgerRes.body.find((t: any) => t.reason === 'REDEEM');
    expect(redeemEntry.points).toBe(-5);
  });

  it('rejects redeeming more points than the customer actually has', async () => {
    const customerRes = await request(app.getHttpServer()).post('/customers').set(auth(adminToken)).send({ phone: '+966511110005' });
    const customerId = customerRes.body.id;
    await payFreshOrder(customerId); // 11 points

    const redeemRes = await request(app.getHttpServer()).post(`/customers/${customerId}/redeem`).set(auth(adminToken)).send({ points: 999 });
    expect(redeemRes.status).toBe(400);

    const customerAfter = await request(app.getHttpServer()).get(`/customers/${customerId}`).set(auth(adminToken));
    expect(customerAfter.body.points).toBe(11); // unchanged
  });

  it('searches customers by phone substring', async () => {
    const res = await request(app.getHttpServer()).get('/customers?phone=511110001').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some((c: any) => c.phone === '+966511110001')).toBe(true);
  });
});
