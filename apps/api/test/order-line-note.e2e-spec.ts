import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// A free-text per-line note (e.g. "بدون بصل") -- persisted on
// OrderLine.note, never affecting pricing/inventory, and surfaced both on
// the order itself (invoice) and on the kitchen queue (KDS ticket).
describe('Order line note (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let locationId: string;
  let shiftId: string;
  let menuItemId: string;

  const PHONE = '+966500000220';
  const PASSWORD = 'OrderLineNoteTest123';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({ where: { user: { phone: PHONE } } });
    await prisma.user.deleteMany({ where: { phone: PHONE } });
    await prisma.rolePermission.deleteMany({ where: { role: { name: 'OrderLineNote-Test-Role' } } });
    await prisma.role.deleteMany({ where: { name: 'OrderLineNote-Test-Role' } });

    const shiftPerm = await prisma.permission.upsert({
      where: { code: 'pos.manage_shift' },
      update: {},
      create: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' },
    });
    const role = await prisma.role.create({ data: { name: 'OrderLineNote-Test-Role' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: shiftPerm.id } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({ data: { name: 'Order Line Note Tester', phone: PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: PHONE, password: PASSWORD });
    token = loginRes.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار ملاحظة الصنف', type: 'BRANCH' } });
    locationId = location.id;
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار الملاحظة', category: 'اختبار', price: 20 } });
    menuItemId = menuItem.id;

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(token)).send({ locationId, openingFloat: 100 });
    shiftId = shiftRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists a note on a line and returns it from GET /orders/:id', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1, note: 'بدون بصل' }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.lines[0].note).toBe('بدون بصل');

    const fetched = await request(app.getHttpServer()).get(`/orders/${orderRes.body.id}`).set(auth(token));
    expect(fetched.body.lines[0].note).toBe('بدون بصل');
  });

  it('a line with no note returns null, never breaking pricing/inventory', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.lines[0].note).toBeNull();
    expect(Number(orderRes.body.grandTotal)).toBeGreaterThan(0);
  });

  it('rejects a note longer than 300 characters', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1, note: 'a'.repeat(301) }] });
    expect(orderRes.status).toBe(400);
  });

  it('surfaces the note on GET /kitchen/queue for that line', async () => {
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(token))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 1, note: 'حار جدًا' }] });
    expect(orderRes.status).toBe(201);

    const queue = await request(app.getHttpServer()).get(`/kitchen/queue?locationId=${locationId}`).set(auth(token));
    const queuedOrder = queue.body.find((o: { orderId: string }) => o.orderId === orderRes.body.id);
    expect(queuedOrder).toBeTruthy();
    expect(queuedOrder.lines[0].note).toBe('حار جدًا');
  });
});
