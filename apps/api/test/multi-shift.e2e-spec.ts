import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A location can now have more than one shift open at once (e.g. two
// tills/registers running concurrently), and any number of cashiers can
// place orders under the SAME open shift -- ShiftsService.open() no longer
// blocks a second concurrent shift, and OrdersService.create() never
// checked shift ownership to begin with (only location scope). This suite
// proves both halves actually work end-to-end against a real API: two
// shifts open side by side, each accumulating its OWN orders/cash
// reconciliation independently, closeable independently, plus a second
// cashier successfully placing an order on a shift a DIFFERENT cashier
// opened.
describe('Multiple concurrent open shifts + multi-cashier shifts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let cashierBToken: string;
  let locationId: string;
  let menuItemId: string;

  const ADMIN_PHONE = '+966500000095';
  const ADMIN_PASSWORD = 'MultiShiftTest123';
  const CASHIER_B_PHONE = '+966500000096';
  const CASHIER_B_PASSWORD = 'CashierBTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: { in: [ADMIN_PHONE, CASHIER_B_PHONE] } } } });
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, CASHIER_B_PHONE] } } });

    const passwordHashA = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await prisma.user.create({ data: { name: 'Multi-Shift Cashier A', phone: ADMIN_PHONE, passwordHash: passwordHashA } });
    const passwordHashB = await bcrypt.hash(CASHIER_B_PASSWORD, 10);
    await prisma.user.create({ data: { name: 'Multi-Shift Cashier B', phone: CASHIER_B_PHONE, passwordHash: passwordHashB } });

    const loginA = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = loginA.body.accessToken;
    const loginB = await request(app.getHttpServer()).post('/auth/login').send({ phone: CASHIER_B_PHONE, password: CASHIER_B_PASSWORD });
    cashierBToken = loginB.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع تعدد الورديات', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف تعدد الورديات', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  let shiftAId: string;
  let shiftBId: string;

  it('opens two shifts concurrently for the same location (no conflict)', async () => {
    const resA = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 200 });
    expect(resA.status).toBe(201);
    shiftAId = resA.body.id;

    const resB = await request(app.getHttpServer()).post('/shifts').set(auth(cashierBToken)).send({ locationId, openingFloat: 150 });
    expect(resB.status).toBe(201);
    shiftBId = resB.body.id;
    expect(shiftBId).not.toBe(shiftAId);

    const listRes = await request(app.getHttpServer()).get('/shifts').set(auth(adminToken));
    const openIds = listRes.body.filter((s: any) => s.locationId === locationId && !s.closedAt).map((s: any) => s.id);
    expect(openIds).toEqual(expect.arrayContaining([shiftAId, shiftBId]));
  });

  it('lets a DIFFERENT cashier place an order on a shift opened by someone else', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(cashierBToken))
      .send({ locationId, shiftId: shiftAId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(res.status).toBe(201);
    const pay = await request(app.getHttpServer())
      .post(`/orders/${res.body.id}/pay`)
      .set(auth(cashierBToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(res.body.grandTotal) }] });
    expect(pay.status).toBe(200);
  });

  it('keeps each shift\'s orders/cash reconciliation independent of the other', async () => {
    // One paid order (20 + 15% VAT = 23.00) already landed on shiftA above.
    // Put a DIFFERENT order on shiftB and confirm it doesn't bleed into A.
    const orderB = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId: shiftBId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    expect(orderB.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/orders/${orderB.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderB.body.grandTotal) }] });

    const closeA = await request(app.getHttpServer())
      .post(`/shifts/${shiftAId}/close`)
      .set(auth(adminToken))
      .send({ closingCounted: 200 + 23 }); // opening float + the one order on A
    expect(closeA.status).toBe(200);
    expect(Number(closeA.body.variance)).toBeCloseTo(0, 2);

    // shiftB must still be open and unaffected by closing shiftA.
    const shiftBCheck = await request(app.getHttpServer()).get(`/shifts/${shiftBId}`).set(auth(adminToken));
    expect(shiftBCheck.body.closedAt).toBeNull();

    const closeB = await request(app.getHttpServer())
      .post(`/shifts/${shiftBId}/close`)
      .set(auth(adminToken))
      .send({ closingCounted: 150 + 46 }); // opening float + the one order on B (2 x 20 + VAT = 46)
    expect(closeB.status).toBe(200);
    expect(Number(closeB.body.variance)).toBeCloseTo(0, 2);
  });
});
