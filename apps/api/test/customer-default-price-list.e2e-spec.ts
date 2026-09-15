import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Customer.defaultSalesChannelId: links a customer (e.g. a delivery-app
// aggregator's own account, a wholesale/company customer) to a price list
// (SalesChannel) so picking them on an order applies their prices
// automatically -- no extra step for the cashier. An explicit
// salesChannelId on the order itself still wins over the customer's
// default, and a customer with no default behaves exactly as before
// (base MenuItem.price).
describe('Customer.defaultSalesChannelId: auto-applied price list (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let locationId: string;
  let menuItemId: string;
  let shiftId: string;

  const ADMIN_PHONE = '+966500000098';
  const ADMIN_PASSWORD = 'CustomerPriceListTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: ADMIN_PHONE } } });
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'Customer-PriceList-Test-Admin' } } });
    await prisma.role.deleteMany({ where: { name: 'Customer-PriceList-Test-Admin' } });

    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const itemsPerm = await prisma.permission.upsert({
      where: { code: 'items.manage' },
      update: {},
      create: { code: 'items.manage', label: 'إدارة أصناف المنيو ووصفاتها' },
    });
    const role = await prisma.role.create({ data: { name: 'Customer-PriceList-Test-Admin' } });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionId: shiftPerm.id },
        { roleId: role.id, permissionId: itemsPerm.id },
      ],
    });

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await prisma.user.create({ data: { name: 'Customer PriceList Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار قوائم أسعار العملاء', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار قوائم الأسعار', category: 'رئيسي', price: 20 } });
    menuItemId = menuItem.id;

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects creating a customer with a non-existent price list (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(adminToken))
      .send({ phone: '+966500000199', name: 'عميل خطأ', defaultSalesChannelId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('creates a customer linked to a price list and applies it automatically on an order', async () => {
    const channel = await request(app.getHttpServer()).post('/sales-channels').set(auth(adminToken)).send({ name: 'قناة توصيل تجريبية' });
    expect(channel.status).toBe(201);
    await request(app.getHttpServer())
      .put(`/items/${menuItemId}/channel-prices/${channel.body.id}`)
      .set(auth(adminToken))
      .send({ price: 35 }); // higher than the base 20 -- delivery-app markup

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(adminToken))
      .send({ phone: '+966500000198', name: 'عميل تطبيق توصيل', defaultSalesChannelId: channel.body.id });
    expect(customer.status).toBe(201);
    expect(customer.body.defaultSalesChannelId).toBe(channel.body.id);

    const order = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DELIVERY_PARTNER', customerId: customer.body.id, lines: [{ menuItemId, quantity: 1 }] });
    expect(order.status).toBe(201);
    // 35 (the channel price, not the base 20) + 15% VAT = 40.25
    expect(Number(order.body.subtotal)).toBe(35);
    expect(order.body.salesChannelId).toBe(channel.body.id);
  });

  it('an explicit salesChannelId on the order still wins over the customer default', async () => {
    const defaultChannel = await request(app.getHttpServer()).post('/sales-channels').set(auth(adminToken)).send({ name: 'قناة افتراضية للعميل' });
    const overrideChannel = await request(app.getHttpServer()).post('/sales-channels').set(auth(adminToken)).send({ name: 'قناة مختارة يدويًا' });
    await request(app.getHttpServer()).put(`/items/${menuItemId}/channel-prices/${defaultChannel.body.id}`).set(auth(adminToken)).send({ price: 35 });
    await request(app.getHttpServer()).put(`/items/${menuItemId}/channel-prices/${overrideChannel.body.id}`).set(auth(adminToken)).send({ price: 50 });

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(adminToken))
      .send({ phone: '+966500000197', name: 'عميل بقائمة افتراضية', defaultSalesChannelId: defaultChannel.body.id });

    const order = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({
        locationId,
        shiftId,
        channel: 'DINE_IN',
        customerId: customer.body.id,
        salesChannelId: overrideChannel.body.id,
        lines: [{ menuItemId, quantity: 1 }],
      });
    expect(order.status).toBe(201);
    expect(Number(order.body.subtotal)).toBe(50); // the explicitly-chosen channel's price, not the customer's default
    expect(order.body.salesChannelId).toBe(overrideChannel.body.id);
  });

  it('a customer with no default price list behaves exactly as before (base price)', async () => {
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(adminToken))
      .send({ phone: '+966500000196', name: 'عميل عادي بلا قائمة' });
    expect(customer.body.defaultSalesChannelId).toBeNull();

    const order = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', customerId: customer.body.id, lines: [{ menuItemId, quantity: 1 }] });
    expect(order.status).toBe(201);
    expect(Number(order.body.subtotal)).toBe(20); // base MenuItem.price
    expect(order.body.salesChannelId).toBeNull();
  });

  it('lets an admin clear a customer\'s default price list back to null', async () => {
    const channel = await request(app.getHttpServer()).post('/sales-channels').set(auth(adminToken)).send({ name: 'قناة لإزالتها لاحقًا' });
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(adminToken))
      .send({ phone: '+966500000195', name: 'عميل لإزالة قائمته', defaultSalesChannelId: channel.body.id });
    expect(customer.body.defaultSalesChannelId).toBe(channel.body.id);

    const cleared = await request(app.getHttpServer())
      .patch(`/customers/${customer.body.id}`)
      .set(auth(adminToken))
      .send({ defaultSalesChannelId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.defaultSalesChannelId).toBeNull();
  });
});
