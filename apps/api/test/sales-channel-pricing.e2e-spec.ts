import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Phase B: SalesChannel price lists (e.g. "هنجر ستيشن") -- a per-item price
// override on a named channel, separate from Order.channel's general
// dine-in/takeaway/delivery classification. Runs against a real app + a
// real Postgres test database.
describe('Sales channel pricing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manageToken: string;
  let noPermToken: string;
  let locationId: string;
  let menuItemId: string;
  let secondMenuItemId: string;

  const MANAGE_PHONE = '+966500000150';
  const NOPERM_PHONE = '+966500000151';
  const PASSWORD = 'ChannelPriceTest123';

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
    await prisma.role.deleteMany({ where: { name: { in: ['ChannelPrice-Test-Manager', 'ChannelPrice-Test-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: 'items.manage' } });

    const itemsPerm = await prisma.permission.create({ data: { code: 'items.manage', label: 'إدارة المنيو' } });
    const role = await prisma.role.create({ data: { name: 'ChannelPrice-Test-Manager' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: itemsPerm.id } });
    await prisma.role.create({ data: { name: 'ChannelPrice-Test-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    manageToken = await makeUser(MANAGE_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);

    const location = await prisma.location.create({ data: { name: 'فرع اختبار قنوات التسعير', type: 'BRANCH' } });
    locationId = location.id;

    const item = await prisma.menuItem.create({ data: { name: 'برجر اختبار', category: 'رئيسي', price: 20 } });
    menuItemId = item.id;
    const secondItem = await prisma.menuItem.create({ data: { name: 'بيبسي اختبار', category: 'مشروبات', price: 5 } });
    secondMenuItemId = secondItem.id;
  });

  afterAll(async () => {
    await app.close();
  });

  let channelId: string;

  it('blocks creating a sales channel without items.manage (403)', async () => {
    const res = await request(app.getHttpServer()).post('/sales-channels').set(auth(noPermToken)).send({ name: 'قناة ممنوعة' });
    expect(res.status).toBe(403);
  });

  it('creates a sales channel', async () => {
    const res = await request(app.getHttpServer()).post('/sales-channels').set(auth(manageToken)).send({ name: 'هنجر ستيشن' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('هنجر ستيشن');
    expect(res.body.isActive).toBe(true);
    channelId = res.body.id;
  });

  it('rejects a duplicate channel name (409)', async () => {
    const res = await request(app.getHttpServer()).post('/sales-channels').set(auth(manageToken)).send({ name: 'هنجر ستيشن' });
    expect(res.status).toBe(409);
  });

  it("an item's channel prices default to its base price with isOverridden:false", async () => {
    const res = await request(app.getHttpServer()).get(`/items/${menuItemId}/channel-prices`).set(auth(manageToken));
    expect(res.status).toBe(200);
    expect(Number(res.body.basePrice)).toBe(20);
    const row = res.body.channels.find((c: { channelId: string }) => c.channelId === channelId);
    expect(Number(row.price)).toBe(20);
    expect(row.isOverridden).toBe(false);
  });

  it('blocks setting a channel price without items.manage (403)', async () => {
    const res = await request(app.getHttpServer())
      .put(`/items/${menuItemId}/channel-prices/${channelId}`)
      .set(auth(noPermToken))
      .send({ price: 25 });
    expect(res.status).toBe(403);
  });

  it('sets a channel-specific price override', async () => {
    const res = await request(app.getHttpServer())
      .put(`/items/${menuItemId}/channel-prices/${channelId}`)
      .set(auth(manageToken))
      .send({ price: 26.5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.price)).toBe(26.5);

    const check = await request(app.getHttpServer()).get(`/items/${menuItemId}/channel-prices`).set(auth(manageToken));
    const row = check.body.channels.find((c: { channelId: string }) => c.channelId === channelId);
    expect(Number(row.price)).toBe(26.5);
    expect(row.isOverridden).toBe(true);
    // The other item was never overridden -- still falls back to its own base price.
    const other = await request(app.getHttpServer()).get(`/items/${secondMenuItemId}/channel-prices`).set(auth(manageToken));
    const otherRow = other.body.channels.find((c: { channelId: string }) => c.channelId === channelId);
    expect(Number(otherRow.price)).toBe(5);
    expect(otherRow.isOverridden).toBe(false);
  });

  it('the item-prices aggregate endpoint reflects the same override for the whole menu at once', async () => {
    const res = await request(app.getHttpServer()).get(`/sales-channels/${channelId}/item-prices`).set(auth(manageToken));
    expect(res.status).toBe(200);
    const overridden = res.body.find((r: { menuItemId: string }) => r.menuItemId === menuItemId);
    expect(Number(overridden.price)).toBe(26.5);
    expect(overridden.isOverridden).toBe(true);
    const notOverridden = res.body.find((r: { menuItemId: string }) => r.menuItemId === secondMenuItemId);
    expect(Number(notOverridden.price)).toBe(5);
    expect(notOverridden.isOverridden).toBe(false);
  });

  it('an order placed WITH the channel prices the overridden item at its channel price, not its base price', async () => {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
    expect(shiftRes.status).toBe(201);
    const shiftId = shiftRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(manageToken))
      .send({
        locationId,
        shiftId,
        channel: 'DELIVERY_PARTNER',
        salesChannelId: channelId,
        lines: [
          { menuItemId, quantity: 2 }, // 26.5 * 2 = 53
          { menuItemId: secondMenuItemId, quantity: 1 }, // no override -- base price 5
        ],
      });
    expect(orderRes.status).toBe(201);
    expect(Number(orderRes.body.subtotal)).toBe(58); // 53 + 5
    const line1 = orderRes.body.lines.find((l: { menuItemId: string }) => l.menuItemId === menuItemId);
    expect(Number(line1.unitPrice)).toBe(26.5);
    const line2 = orderRes.body.lines.find((l: { menuItemId: string }) => l.menuItemId === secondMenuItemId);
    expect(Number(line2.unitPrice)).toBe(5);

    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(manageToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });
    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
  });

  it('an order placed WITHOUT a salesChannelId still uses each item base price (no regression)', async () => {
    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 200 });
    const shiftId = shiftRes.body.id;

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(manageToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(Number(orderRes.body.subtotal)).toBe(20); // base price, unaffected by the channel override above

    await request(app.getHttpServer()).post(`/shifts/${shiftId}/close`).set(auth(manageToken)).send({ closingCounted: 200 });
  });

  it('removes the channel price override, falling back to the base price again', async () => {
    const del = await request(app.getHttpServer()).delete(`/items/${menuItemId}/channel-prices/${channelId}`).set(auth(manageToken));
    expect(del.status).toBe(200);

    const check = await request(app.getHttpServer()).get(`/items/${menuItemId}/channel-prices`).set(auth(manageToken));
    const row = check.body.channels.find((c: { channelId: string }) => c.channelId === channelId);
    expect(Number(row.price)).toBe(20);
    expect(row.isOverridden).toBe(false);
  });

  it('refuses to hard-delete a channel that still has priced items (400), suggesting deactivation instead', async () => {
    await request(app.getHttpServer()).put(`/items/${menuItemId}/channel-prices/${channelId}`).set(auth(manageToken)).send({ price: 22 });
    const res = await request(app.getHttpServer()).delete(`/sales-channels/${channelId}`).set(auth(manageToken));
    expect(res.status).toBe(400);
  });

  it('deactivating a channel (isActive:false) works and it no longer appears in an item channel-prices list', async () => {
    const res = await request(app.getHttpServer()).patch(`/sales-channels/${channelId}`).set(auth(manageToken)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);

    const check = await request(app.getHttpServer()).get(`/items/${menuItemId}/channel-prices`).set(auth(manageToken));
    expect(check.body.channels.find((c: { channelId: string }) => c.channelId === channelId)).toBeUndefined();
  });
});
