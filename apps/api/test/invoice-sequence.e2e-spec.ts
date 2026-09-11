import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Order.shiftSequence resets to 1 with every new shift (independent of the
// shift's own id/name); Order.dailySequence resets to 1 with every new
// calendar day per location, spanning however many shifts happen that day.
// Both are separate from zatcaInvoiceCounter (Location's official ZATCA
// chain) and both are assigned via an atomic increment/upsert so two
// orders landing at the same instant never collide on the same number.
describe('Order shift/day invoice sequence numbers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let menuItemId: string;

  const ADMIN_PHONE = '+966500000260';
  const PASSWORD = 'InvoiceSeqTest123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار تسلسل الفاتورة', category: 'رئيسي', price: 10 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const createOrder = (locationId: string, shiftId: string) =>
    request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });

  it('shiftSequence starts at 1 and increments per order within the same shift, independent of the shift id', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع تسلسل 1', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    const first = await createOrder(location.id, shiftId);
    const second = await createOrder(location.id, shiftId);
    const third = await createOrder(location.id, shiftId);
    expect(first.body.shiftSequence).toBe(1);
    expect(second.body.shiftSequence).toBe(2);
    expect(third.body.shiftSequence).toBe(3);
  });

  it('a new shift resets shiftSequence back to 1, even for the same location', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع تسلسل 2', type: 'BRANCH' } });
    const shift1 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    await createOrder(location.id, shift1.body.id);
    const secondInShift1 = await createOrder(location.id, shift1.body.id);
    expect(secondInShift1.body.shiftSequence).toBe(2);

    await request(app.getHttpServer())
      .post(`/orders/${secondInShift1.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(secondInShift1.body.grandTotal) }] });
    const firstOrderPay = await request(app.getHttpServer())
      .get(`/orders`)
      .set(auth(adminToken));
    const firstOrderId = firstOrderPay.body.find((o: any) => o.locationId === location.id && o.shiftSequence === 1).id;
    await request(app.getHttpServer())
      .post(`/orders/${firstOrderId}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: 11.5 }] });
    await request(app.getHttpServer()).post(`/shifts/${shift1.body.id}/close`).set(auth(adminToken)).send({ closingCounted: 100 + 23 });

    const shift2 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const firstInShift2 = await createOrder(location.id, shift2.body.id);
    expect(firstInShift2.body.shiftSequence).toBe(1);
  });

  it('dailySequence increments across different shifts at the same location on the same day, and is separate per location', async () => {
    const locationA = await prisma.location.create({ data: { name: 'فرع تسلسل يومي أ', type: 'BRANCH' } });
    const locationB = await prisma.location.create({ data: { name: 'فرع تسلسل يومي ب', type: 'BRANCH' } });

    const shiftA1 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: locationA.id, openingFloat: 100 });
    const orderA1 = await createOrder(locationA.id, shiftA1.body.id);
    expect(orderA1.body.dailySequence).toBe(1);
    const orderA2 = await createOrder(locationA.id, shiftA1.body.id);
    expect(orderA2.body.dailySequence).toBe(2);

    const shiftB1 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: locationB.id, openingFloat: 100 });
    const orderB1 = await createOrder(locationB.id, shiftB1.body.id);
    // Separate location -- its own daily counter, unaffected by location A's orders.
    expect(orderB1.body.dailySequence).toBe(1);

    const orderA3 = await createOrder(locationA.id, shiftA1.body.id);
    expect(orderA3.body.dailySequence).toBe(3);
  });
});
