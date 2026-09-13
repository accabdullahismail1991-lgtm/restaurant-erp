import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Shift.shiftNumber: a human-friendly "SH{n}" number per location (1, 2,
// 3, ...), assigned atomically from Location.lastShiftNumber the same way
// ZatcaService's invoice counter already is -- independent per location,
// never reused. Shifts.closeSummary(): a brief per-shift recap (sales by
// menu category, by item, by order channel) meant to print right after
// closing -- deliberately not gated behind analytics.view since it's
// available to whoever can close the shift.
describe('Shift numbering + close-summary report (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  const ADMIN_PHONE = '+966500000170';
  const PASSWORD = 'ShiftNumTest123';
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
    await prisma.user.deleteMany({ where: { phone: ADMIN_PHONE } });
    await prisma.role.deleteMany({ where: { name: 'ShiftNumTest-Manager' } });
    await prisma.permission.deleteMany({ where: { code: 'combos.manage' } });

    const managePerm = await prisma.permission.upsert({
      where: { code: 'combos.manage' },
      update: {},
      create: { code: 'combos.manage', label: 'إدارة وجبات الكمبو والبوكس' },
    });
    const manageRole = await prisma.role.create({ data: { name: 'ShiftNumTest-Manager' } });
    await prisma.rolePermission.create({ data: { roleId: manageRole.id, permissionId: managePerm.id } });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const adminUser = await prisma.user.create({ data: { name: 'Admin', phone: ADMIN_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: manageRole.id } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: ADMIN_PHONE, password: PASSWORD });
    adminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('assigns sequential shiftNumber per location, independent of other locations', async () => {
    const locA = await prisma.location.create({ data: { name: 'فرع اختبار ترقيم الورديات A', type: 'BRANCH' } });
    const locB = await prisma.location.create({ data: { name: 'فرع اختبار ترقيم الورديات B', type: 'BRANCH' } });

    const s1 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: locA.id, openingFloat: 100 });
    expect(s1.body.shiftNumber).toBe(1);
    await request(app.getHttpServer()).post(`/shifts/${s1.body.id}/close`).set(auth(adminToken)).send({ closingCounted: 100 });

    const s2 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: locA.id, openingFloat: 100 });
    expect(s2.body.shiftNumber).toBe(2); // second shift at the SAME location

    const s3 = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: locB.id, openingFloat: 100 });
    expect(s3.body.shiftNumber).toBe(1); // a DIFFERENT location starts its own count at 1
  });

  it('produces a brief close-summary: sales by category, by item (incl. combos), and by order channel', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار ملخص الوردية', type: 'BRANCH' } });

    const burger = await prisma.menuItem.create({ data: { name: 'برجر -- ملخص وردية', category: 'رئيسي', price: 20 } });
    const salad = await prisma.menuItem.create({ data: { name: 'سلطة -- ملخص وردية', category: 'مقبلات', price: 10 } });
    const comboMain = await prisma.menuItem.create({ data: { name: 'برجر كمبو -- ملخص وردية', category: 'رئيسي', price: 20 } });

    const comboRes = await request(app.getHttpServer())
      .post('/combos')
      .set(auth(adminToken))
      .send({
        name: 'كمبو -- ملخص وردية',
        basePrice: 25,
        slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: comboMain.id, extraPrice: 0 }] }],
      });
    const slot = comboRes.body.slots[0];

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(adminToken)).send({ locationId: location.id, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    // Order 1 (DINE_IN): 2x burger (40) + 1x salad (10) = 50
    const order1 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: burger.id, quantity: 2 }, { menuItemId: salad.id, quantity: 1 }] });
    await request(app.getHttpServer()).post(`/orders/${order1.body.id}/pay`).set(auth(adminToken)).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order1.body.grandTotal) }] });

    // Order 2 (TAKEAWAY): 1x combo (25)
    const order2 = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({
        locationId: location.id,
        shiftId,
        channel: 'TAKEAWAY',
        lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [{ comboSlotId: slot.id, menuItemId: comboMain.id, quantity: 1 }] }],
      });
    await request(app.getHttpServer()).post(`/orders/${order2.body.id}/pay`).set(auth(adminToken)).send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(order2.body.grandTotal) }] });

    // Order 3: left UNPAID (still SENT_TO_KITCHEN) -- must be excluded entirely
    await request(app.getHttpServer())
      .post('/orders')
      .set(auth(adminToken))
      .send({ locationId: location.id, shiftId, channel: 'DINE_IN', lines: [{ menuItemId: burger.id, quantity: 5 }] });

    const res = await request(app.getHttpServer()).get(`/shifts/${shiftId}/close-summary`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(2); // the unpaid 3rd order is excluded
    expect(res.body.itemCount).toBe(4); // 2 burgers + 1 salad + 1 combo
    // Top-level revenue is order-level grandTotal (VAT-inclusive, same
    // convention as AnalyticsService.salesSummary) -- 75 subtotal * 1.15
    // default VAT rate. byCategory/byItem below stay at line-subtotal
    // level (pre-VAT), same convention as AnalyticsService.topItemsCore.
    expect(res.body.revenue).toBe(86.25);

    const byCategory = (cat: string) => res.body.byCategory.find((c: { category: string }) => c.category === cat);
    expect(byCategory('رئيسي')).toMatchObject({ quantity: 2, revenue: 40 }); // 2 regular burgers only -- combo's own item is under its own category
    expect(byCategory('مقبلات')).toMatchObject({ quantity: 1, revenue: 10 });
    expect(byCategory('عروض / كمبو')).toMatchObject({ quantity: 1, revenue: 25 });

    const byItem = (name: string) => res.body.byItem.find((i: { name: string }) => i.name === name);
    expect(byItem('برجر -- ملخص وردية')).toMatchObject({ quantity: 2, revenue: 40 });
    expect(byItem('سلطة -- ملخص وردية')).toMatchObject({ quantity: 1, revenue: 10 });
    expect(byItem('كمبو -- ملخص وردية')).toMatchObject({ quantity: 1, revenue: 25 });

    const byChannel = (ch: string) => res.body.byChannel.find((c: { channel: string }) => c.channel === ch);
    expect(byChannel('DINE_IN')).toMatchObject({ orderCount: 1, revenue: 57.5 }); // 50 * 1.15 VAT
    expect(byChannel('TAKEAWAY')).toMatchObject({ orderCount: 1, revenue: 28.75 }); // 25 * 1.15 VAT
  });

  it('works even without analytics.view -- a plain cashier can read their own shift close-summary', async () => {
    const location = await prisma.location.create({ data: { name: 'فرع اختبار صلاحية الملخص', type: 'BRANCH' } });
    const NOPERM_PHONE = '+966500000171';
    await prisma.user.deleteMany({ where: { phone: NOPERM_PHONE } });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({ data: { name: 'Cashier', phone: NOPERM_PHONE, passwordHash } });
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    const cashierToken = loginRes.body.accessToken;

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(cashierToken)).send({ locationId: location.id, openingFloat: 50 });
    const res = await request(app.getHttpServer()).get(`/shifts/${shiftRes.body.id}/close-summary`).set(auth(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(0);
  });
});
