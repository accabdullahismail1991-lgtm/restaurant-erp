import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Order.invoiceType: CASH (نقدية, the default -- paid at the point of
// sale) vs CREDIT (آجل -- billed to a specific customer's account to be
// settled later). CREDIT requires a customer for exactly that reason.
describe('Order invoice type: CASH vs CREDIT (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let menuItemId: string;

  const ADMIN_PHONE = '+966500000250';
  const PASSWORD = 'InvoiceTypeTest123';
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

    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار نوع الفاتورة', category: 'رئيسي', price: 40 } });
    menuItemId = menuItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('defaults to CASH when invoiceType is omitted', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع افتراضي نقدي', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.invoiceType).toBe('CASH');
  });

  it('rejects a CREDIT invoice with no customer (400)', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع آجل بدون عميل', type: 'BRANCH' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId: shiftRes.body.id, channel: 'DINE_IN', invoiceType: 'CREDIT', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(400);
    expect(orderRes.body.message).toContain('آجل');
  });

  it('accepts a CREDIT invoice once a customer is given', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع آجل بعميل', type: 'BRANCH' } });
    const customer = await prisma.customer.create({ data: { name: 'عميل آجل', phone: '+966511110001' } });
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({
        locationId: location.id,
        shiftId: shiftRes.body.id,
        channel: 'DINE_IN',
        invoiceType: 'CREDIT',
        customerId: customer.id,
        lines: [{ menuItemId, quantity: 1 }],
      });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.invoiceType).toBe('CREDIT');

    const fetched = await request(app.getHttpServer()).get(`/orders/${orderRes.body.id}`).set(auth(adminToken));
    expect(fetched.body.invoiceType).toBe('CREDIT');
  });
});
