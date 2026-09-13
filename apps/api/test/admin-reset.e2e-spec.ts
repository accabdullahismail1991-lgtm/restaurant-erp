import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Two destructive admin actions, both gated by system.reset_data:
// resetMasterData() wipes the product catalog (ingredients/recipes/menu
// items/combos) plus every transactional table that has a real, non-cascading
// FK into them (orders, inventory, purchasing, production, transfers,
// stocktakes) -- FK reality means the catalog can't be cleared without also
// clearing its usage history. It deliberately keeps branches, suppliers,
// customers, shifts, sales channels, promotions and every user/role/
// permission. fullWipe() additionally clears those too, but still never
// touches User/Role/Permission -- otherwise the admin performing the wipe
// would lock themselves out with no way back in short of re-seeding.
describe('Admin data reset/wipe (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let noPermToken: string;

  const ADMIN_PHONE = '+966500000230';
  const NOPERM_PHONE = '+966500000231';
  const PASSWORD = 'AdminResetTest123';
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
    await prisma.user.deleteMany({ where: { phone: { in: [ADMIN_PHONE, NOPERM_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: { in: ['AdminReset-Full', 'AdminReset-NoPerm'] } } });
    await prisma.permission.deleteMany({ where: { code: 'system.reset_data' } });

    const perm = await prisma.permission.create({ data: { code: 'system.reset_data', label: 'حذف/تصفير بيانات النظام' } });
    let adjustPerm = await prisma.permission.findUnique({ where: { code: 'inventory.adjust' } });
    if (!adjustPerm) adjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية أرصدة المخزون' } });
    const role = await prisma.role.create({ data: { name: 'AdminReset-Full' } });
    await prisma.rolePermission.createMany({ data: [perm, adjustPerm].map((p) => ({ roleId: role.id, permissionId: p.id })) });
    await prisma.role.create({ data: { name: 'AdminReset-NoPerm' } });

    const makeUser = async (phone: string, roleId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };
    adminToken = await makeUser(ADMIN_PHONE, role.id);
    noPermToken = await makeUser(NOPERM_PHONE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks both endpoints without system.reset_data (403)', async () => {
    const res1 = await request(app.getHttpServer())
      .post('/admin/reset-master-data')
      .set(auth(noPermToken))
      .send({ confirm: 'RESET-MASTER-DATA' });
    expect(res1.status).toBe(403);

    const res2 = await request(app.getHttpServer())
      .post('/admin/full-wipe')
      .set(auth(noPermToken))
      .send({ confirm: 'FULL-WIPE-EVERYTHING' });
    expect(res2.status).toBe(403);
  });

  it('rejects a request with a missing/wrong confirm phrase (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/reset-master-data')
      .set(auth(adminToken))
      .send({ confirm: 'nope' });
    expect(res.status).toBe(400);
  });

  it('resetMasterData clears the catalog + its full usage history, keeps branches/suppliers/customers/users', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار التصفير', type: 'BRANCH' } });
    const supplier = await prisma.supplier.create({ data: { name: 'مورد اختبار التصفير' } });
    const customer = await prisma.customer.create({ data: { name: 'عميل اختبار التصفير', phone: '+966599990001' } });

    const ingredient = await prisma.ingredient.create({
      data: { name: 'مكوّن اختبار التصفير', unit: 'kg', kind: 'RAW_MATERIAL', lowStockThreshold: 0 },
    });
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف اختبار التصفير', category: 'اختبار', price: 30 } });
    await prisma.recipeLine.create({ data: { menuItemId: menuItem.id, ingredientId: ingredient.id, quantity: 1 } });

    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(adminToken))
      .send({ locationId: location.id, ingredientId: ingredient.id, quantity: 100, unitCost: 5 });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 50 });
    const shiftId = shiftRes.body.id;
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: menuItem.id, quantity: 2 }] });
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(adminToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    const res = await request(app.getHttpServer())
      .post('/admin/reset-master-data')
      .set(auth(adminToken))
      .send({ confirm: 'RESET-MASTER-DATA' });
    expect(res.status).toBe(201);
    expect(res.body.ingredients).toBeGreaterThanOrEqual(1);
    expect(res.body.menuItems).toBeGreaterThanOrEqual(1);
    expect(res.body.orders).toBeGreaterThanOrEqual(1);

    expect(await prisma.ingredient.count()).toBe(0);
    expect(await prisma.menuItem.count()).toBe(0);
    expect(await prisma.recipeLine.count()).toBe(0);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(await prisma.inventoryBatch.count()).toBe(0);

    // Kept: branch, supplier, customer, and the admin's own login.
    expect(await prisma.location.findUnique({ where: { id: location.id } })).not.toBeNull();
    expect(await prisma.supplier.findUnique({ where: { id: supplier.id } })).not.toBeNull();
    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).not.toBeNull();
    const stillLoggedIn = await request(app.getHttpServer())
      .post('/admin/full-wipe')
      .set(auth(adminToken))
      .send({ confirm: 'wrong-phrase' });
    expect(stillLoggedIn.status).toBe(400); // 400 (validation), not 401 -- the admin's own token still works
  });

  it('fullWipe additionally clears branches/suppliers/customers, resets payment methods, but keeps users/roles', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع قبل التفريغ الكامل', type: 'BRANCH' } });
    await prisma.supplier.create({ data: { name: 'مورد قبل التفريغ الكامل' } });
    await prisma.customer.create({ data: { name: 'عميل قبل التفريغ الكامل', phone: '+966599990002' } });

    const res = await request(app.getHttpServer())
      .post('/admin/full-wipe')
      .set(auth(adminToken))
      .send({ confirm: 'FULL-WIPE-EVERYTHING' });
    expect(res.status).toBe(201);

    expect(await prisma.location.count()).toBe(0);
    expect(await prisma.supplier.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);

    const paymentMethods = await prisma.paymentMethod.findMany();
    expect(paymentMethods.map((m) => m.code).sort()).toEqual(['CARD', 'CASH', 'STAFF_MEAL', 'WALLET']);

    // The admin's own account survives -- fullWipe() never touches Users.
    const stillWorks = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ phone: ADMIN_PHONE, password: PASSWORD });
    expect(stillWorks.status).toBe(201);
    expect(await prisma.user.findFirst({ where: { phone: ADMIN_PHONE } })).not.toBeNull();
  });

  it('deletes location right after the location referenced above without leftover FK-blocked rows', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع نهائي', type: 'BRANCH' } });
    await prisma.dayClose.create({
      data: { locationId: location.id, businessDate: new Date(), shiftsCount: 0, totalRevenue: 0, totalVariance: 0 },
    });

    const res = await request(app.getHttpServer())
      .post('/admin/full-wipe')
      .set(auth(adminToken))
      .send({ confirm: 'FULL-WIPE-EVERYTHING' });
    expect(res.status).toBe(201);
    expect(await prisma.dayClose.count()).toBe(0);
    expect(await prisma.location.count()).toBe(0);
  });
});
