import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resetDatabase } from './reset-db';

// Combo/box meals: a ComboMeal has one or more ComboSlots ("الفئة", e.g.
// "الطبق الرئيسي"/"المشروب"), each with minSelect/maxSelect and a list of
// ComboSlotOptions (a menu item + an optional extraPrice upcharge). At order
// time the cashier's choice for every slot is snapshotted as ComboSelection
// rows on one OrderLine (comboMealId set, menuItemId null) -- the "exactly
// one parent" pattern OrderLine already used for RecipeLine. This suite
// covers combo CRUD/validation and OrdersService.create()'s combo-line
// handling: price computation, slot validation, and inventory consumption
// scaled by selection quantity x line quantity.
describe('Combo meals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manageToken: string;
  let noPermToken: string;
  let locationId: string;

  const MANAGE_PHONE = '+966500000160';
  const NOPERM_PHONE = '+966500000161';
  const PASSWORD = 'ComboTest123';
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
    await prisma.role.deleteMany({ where: { name: 'Combo-Test-Manager' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['combos.manage', 'pos.return_order', 'pos.manage_shift', 'production.view'] } } });

    const managePerm = await prisma.permission.create({ data: { code: 'combos.manage', label: 'إدارة وجبات الكمبو والبوكس' } });
    const returnPerm = await prisma.permission.create({ data: { code: 'pos.return_order', label: 'عمل مرتجع للطلب' } });
    const shiftPerm = await prisma.permission.create({ data: { code: 'pos.manage_shift', label: 'فتح/إغلاق وردية' } });
    const productionViewPerm = await prisma.permission.create({ data: { code: 'production.view', label: 'عرض أوامر الإنتاج' } });
    const manageRole = await prisma.role.create({ data: { name: 'Combo-Test-Manager' } });
    await prisma.rolePermission.createMany({ data: [managePerm, returnPerm, shiftPerm, productionViewPerm].map((p) => ({ roleId: manageRole.id, permissionId: p.id })) });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const manageUser = await prisma.user.create({ data: { name: MANAGE_PHONE, phone: MANAGE_PHONE, passwordHash } });
    await prisma.userRole.create({ data: { userId: manageUser.id, roleId: manageRole.id } });
    await prisma.user.create({ data: { name: NOPERM_PHONE, phone: NOPERM_PHONE, passwordHash } });

    const manageLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: MANAGE_PHONE, password: PASSWORD });
    manageToken = manageLogin.body.accessToken;
    const noPermLogin = await request(app.getHttpServer()).post('/auth/login').send({ phone: NOPERM_PHONE, password: PASSWORD });
    noPermToken = noPermLogin.body.accessToken;

    const location = await prisma.location.create({ data: { name: 'فرع اختبار الكمبو', type: 'BRANCH', allowNegativeStock: true } });
    locationId = location.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Each order-creation test opens its own shift, and ShiftsService only
  // allows one OPEN shift per location at a time -- so every test in that
  // describe block gets its own fresh location rather than sharing one and
  // silently colliding with a shift left open by an earlier test.
  let comboLocationCounter = 0;
  const newLocation = async () => {
    comboLocationCounter += 1;
    const location = await prisma.location.create({
      data: { name: `فرع اختبار الكمبو -- طلب ${comboLocationCounter}`, type: 'BRANCH', allowNegativeStock: true, autoGenerateProductionOrders: true },
    });
    return location.id;
  };

  describe('CRUD + validation', () => {
    it('blocks creating a combo without combos.manage (403)', async () => {
      const burger = await prisma.menuItem.create({ data: { name: 'برجر -- كرود', category: 'رئيسي', price: 15 } });
      const res = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(noPermToken))
        .send({ name: 'كمبو -- بلا صلاحية', basePrice: 20, slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: burger.id, extraPrice: 0 }] }] });
      expect(res.status).toBe(403);
    });

    it('rejects minSelect > maxSelect (400)', async () => {
      const item = await prisma.menuItem.create({ data: { name: 'صنف -- min>max', category: 'رئيسي', price: 10 } });
      const res = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو min>max', basePrice: 10, slots: [{ label: 'فئة', minSelect: 2, maxSelect: 1, options: [{ menuItemId: item.id, extraPrice: 0 }] }] });
      expect(res.status).toBe(400);
    });

    it('rejects maxSelect greater than the number of options (400)', async () => {
      const item = await prisma.menuItem.create({ data: { name: 'صنف -- max>options', category: 'رئيسي', price: 10 } });
      const res = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو max>options', basePrice: 10, slots: [{ label: 'فئة', minSelect: 1, maxSelect: 2, options: [{ menuItemId: item.id, extraPrice: 0 }] }] });
      expect(res.status).toBe(400);
    });

    it('rejects a non-existent option menuItemId (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو صنف وهمي', basePrice: 10, slots: [{ label: 'فئة', minSelect: 1, maxSelect: 1, options: [{ menuItemId: 'no-such-item', extraPrice: 0 }] }] });
      expect(res.status).toBe(400);
    });

    it('creates, lists, fetches, and updates top-level fields of a combo', async () => {
      const main = await prisma.menuItem.create({ data: { name: 'برجر -- كرود CRUD', category: 'رئيسي', price: 15 } });
      const side = await prisma.menuItem.create({ data: { name: 'بطاطس -- كرود', category: 'جانبي', price: 8 } });

      const createRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({
          name: 'كمبو تجريبي',
          basePrice: 20,
          slots: [
            { label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: main.id, extraPrice: 0 }] },
            { label: 'الجانبي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: side.id, extraPrice: 3 }] },
          ],
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.name).toBe('كمبو تجريبي');
      expect(Number(createRes.body.basePrice)).toBe(20);
      expect(createRes.body.slots).toHaveLength(2);
      expect(createRes.body.slots[1].options[0].extraPrice).toBeDefined();
      const comboId = createRes.body.id;

      const listRes = await request(app.getHttpServer()).get('/combos').set(auth(noPermToken));
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((c: { id: string }) => c.id === comboId)).toBe(true);

      const getRes = await request(app.getHttpServer()).get(`/combos/${comboId}`).set(auth(noPermToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body.slots).toHaveLength(2);

      const updateRes = await request(app.getHttpServer())
        .patch(`/combos/${comboId}`)
        .set(auth(manageToken))
        .send({ name: 'كمبو تجريبي -- محدث', basePrice: 22 });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.name).toBe('كمبو تجريبي -- محدث');
      expect(Number(updateRes.body.basePrice)).toBe(22);
      // Slots untouched by update (deliberately not editable post-creation).
      expect(updateRes.body.slots).toHaveLength(2);
    });
  });

  describe('order creation with a combo line', () => {
    it('computes price, snapshots selections, and consumes inventory scaled by selection qty x line qty', async () => {
      const locationId = await newLocation();
      const burger = await prisma.menuItem.create({ data: { name: 'برجر -- طلب كمبو', category: 'رئيسي', price: 15 } });
      const friesIng = await prisma.ingredient.create({ data: { name: 'بطاطس خام -- طلب كمبو', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
      const fries = await prisma.menuItem.create({ data: { name: 'بطاطس -- طلب كمبو', category: 'جانبي', price: 8 } });
      await prisma.recipeLine.create({ data: { menuItemId: fries.id, ingredientId: friesIng.id, quantity: 100 } });
      const saladIng = await prisma.ingredient.create({ data: { name: 'خس -- طلب كمبو', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
      const salad = await prisma.menuItem.create({ data: { name: 'سلطة -- طلب كمبو', category: 'جانبي', price: 6 } });
      await prisma.recipeLine.create({ data: { menuItemId: salad.id, ingredientId: saladIng.id, quantity: 50 } });
      const burgerIng = await prisma.ingredient.create({ data: { name: 'لحم -- طلب كمبو', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
      await prisma.recipeLine.create({ data: { menuItemId: burger.id, ingredientId: burgerIng.id, quantity: 120 } });

      for (const ing of [friesIng, saladIng, burgerIng]) {
        await prisma.inventoryBatch.create({ data: { locationId, ingredientId: ing.id, batchNumber: `TEST-COMBO-${ing.id}`, quantity: 100000, unitCost: 1, sourceType: 'MANUAL' } });
        await prisma.inventoryBalance.create({ data: { locationId, ingredientId: ing.id, quantity: 100000 } });
      }

      const comboRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({
          name: 'كمبو الطلب',
          basePrice: 20,
          slots: [
            { label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: burger.id, extraPrice: 0 }] },
            { label: 'الجانبي', minSelect: 1, maxSelect: 2, options: [{ menuItemId: fries.id, extraPrice: 0 }, { menuItemId: salad.id, extraPrice: 3 }] },
          ],
        });
      const combo = comboRes.body;
      const mainSlot = combo.slots.find((s: { label: string }) => s.label === 'الرئيسي');
      const sideSlot = combo.slots.find((s: { label: string }) => s.label === 'الجانبي');

      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });
      const shiftId = shiftRes.body.id;

      // 2 combos ordered, each choosing 1 burger + both sides (fries + salad).
      // Expected unit price = 20 (base) + 0 (burger) + 0 (fries) + 3 (salad) = 23.
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId,
          shiftId,
          channel: 'DINE_IN',
          lines: [
            {
              comboMealId: combo.id,
              quantity: 2,
              comboSelections: [
                { comboSlotId: mainSlot.id, menuItemId: burger.id, quantity: 1 },
                { comboSlotId: sideSlot.id, menuItemId: fries.id, quantity: 1 },
                { comboSlotId: sideSlot.id, menuItemId: salad.id, quantity: 1 },
              ],
            },
          ],
        });
      expect(orderRes.status).toBe(201);
      expect(orderRes.body.lines).toHaveLength(1);
      const line = orderRes.body.lines[0];
      expect(line.menuItemId).toBeNull();
      expect(line.comboMealId).toBe(combo.id);
      expect(Number(line.unitPrice)).toBe(23);
      expect(Number(orderRes.body.subtotal)).toBe(46); // 23 * 2

      const detail = await request(app.getHttpServer()).get(`/orders/${orderRes.body.id}`).set(auth(manageToken));
      expect(detail.body.lines[0].comboSelections).toHaveLength(3);
      expect(detail.body.lines[0].comboMeal.name).toBe('كمبو الطلب');

      // Each selection consumed at sel.quantity(1) x line.quantity(2) = 2 units of that menu item's recipe.
      const burgerBalance = await prisma.inventoryBalance.findFirst({ where: { locationId, ingredientId: burgerIng.id } });
      expect(Number(burgerBalance!.quantity)).toBe(100000 - 120 * 2);
      const friesBalance = await prisma.inventoryBalance.findFirst({ where: { locationId, ingredientId: friesIng.id } });
      expect(Number(friesBalance!.quantity)).toBe(100000 - 100 * 2);
      const saladBalance = await prisma.inventoryBalance.findFirst({ where: { locationId, ingredientId: saladIng.id } });
      expect(Number(saladBalance!.quantity)).toBe(100000 - 50 * 2);
    });

    it('rejects a line specifying both menuItemId and comboMealId (400)', async () => {
      const locationId = await newLocation();
      const item = await prisma.menuItem.create({ data: { name: 'صنف -- both', category: 'رئيسي', price: 10 } });
      const combo = await prisma.comboMeal.create({ data: { name: 'كمبو -- both', basePrice: 10 } });
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({ locationId, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ menuItemId: item.id, comboMealId: combo.id, quantity: 1 }] });
      expect(res.status).toBe(400);
    });

    it('rejects a line specifying neither menuItemId nor comboMealId (400)', async () => {
      const locationId = await newLocation();
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({ locationId, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ quantity: 1 }] });
      expect(res.status).toBe(400);
    });

    it('rejects a slot selection quantity outside minSelect/maxSelect (400)', async () => {
      const locationId = await newLocation();
      const main = await prisma.menuItem.create({ data: { name: 'برجر -- min/max', category: 'رئيسي', price: 15 } });
      const comboRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو -- min/max', basePrice: 15, slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: main.id, extraPrice: 0 }] }] });
      const slot = comboRes.body.slots[0];
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });

      // 0 selections for a minSelect=1 slot.
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({ locationId, shiftId: shiftRes.body.id, channel: 'DINE_IN', lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [] }] });
      expect(res.status).toBe(400);

      // 2 selections for a maxSelect=1 slot.
      const res2 = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId,
          shiftId: shiftRes.body.id,
          channel: 'DINE_IN',
          lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [{ comboSlotId: slot.id, menuItemId: main.id, quantity: 2 }] }],
        });
      expect(res2.status).toBe(400);
    });

    it('rejects choosing an item that is not one of the slot\'s options (400)', async () => {
      const locationId = await newLocation();
      const main = await prisma.menuItem.create({ data: { name: 'برجر -- خيار خاطئ', category: 'رئيسي', price: 15 } });
      const outsider = await prisma.menuItem.create({ data: { name: 'صنف خارج الكمبو', category: 'رئيسي', price: 5 } });
      const comboRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو -- خيار خاطئ', basePrice: 15, slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: main.id, extraPrice: 0 }] }] });
      const slot = comboRes.body.slots[0];
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });

      const res = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId,
          shiftId: shiftRes.body.id,
          channel: 'DINE_IN',
          lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [{ comboSlotId: slot.id, menuItemId: outsider.id, quantity: 1 }] }],
        });
      expect(res.status).toBe(400);
    });

    it('rejects ordering an inactive combo (400)', async () => {
      const locationId = await newLocation();
      const main = await prisma.menuItem.create({ data: { name: 'برجر -- كمبو معطل', category: 'رئيسي', price: 15 } });
      const comboRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو معطل', basePrice: 15, slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: main.id, extraPrice: 0 }] }] });
      await request(app.getHttpServer()).patch(`/combos/${comboRes.body.id}`).set(auth(manageToken)).send({ isActive: false });
      const slot = comboRes.body.slots[0];
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });

      const res = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId,
          shiftId: shiftRes.body.id,
          channel: 'DINE_IN',
          lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [{ comboSlotId: slot.id, menuItemId: main.id, quantity: 1 }] }],
        });
      expect(res.status).toBe(400);
    });

    it('triggers auto-generated production for a SEMI_FINISHED ingredient consumed via a combo selection', async () => {
      const locationId = await newLocation();
      const dough = await prisma.ingredient.create({ data: { name: 'عجينة -- كمبو إنتاج', unit: 'g', kind: 'SEMI_FINISHED', lowStockThreshold: 0 } });
      const flour = await prisma.ingredient.create({ data: { name: 'دقيق -- كمبو إنتاج', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 0 } });
      await prisma.recipeLine.create({ data: { parentIngredientId: dough.id, ingredientId: flour.id, quantity: 2 } });
      const bread = await prisma.menuItem.create({ data: { name: 'خبز -- كمبو إنتاج', category: 'رئيسي', price: 10 } });
      await prisma.recipeLine.create({ data: { menuItemId: bread.id, ingredientId: dough.id, quantity: 5 } });

      const comboRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو -- إنتاج تلقائي', basePrice: 12, slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: bread.id, extraPrice: 0 }] }] });
      const slot = comboRes.body.slots[0];
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });

      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId,
          shiftId: shiftRes.body.id,
          channel: 'DINE_IN',
          lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [{ comboSlotId: slot.id, menuItemId: bread.id, quantity: 1 }] }],
        });
      expect(orderRes.status).toBe(201);

      const listRes = await request(app.getHttpServer()).get(`/production-orders?locationId=${locationId}`).set(auth(manageToken));
      const po = listRes.body.find((p: { outputIngredientId: string }) => p.outputIngredientId === dough.id);
      expect(po).toBeDefined();
      expect(po.autoGenerated).toBe(true);
      expect(Number(po.outputQuantity)).toBe(5); // 5g dough per bread, 1 bread ordered
    });

    it('rejects returning a combo-meal order line', async () => {
      const locationId = await newLocation();
      const main = await prisma.menuItem.create({ data: { name: 'برجر -- مرتجع كمبو', category: 'رئيسي', price: 15 } });
      const comboRes = await request(app.getHttpServer())
        .post('/combos')
        .set(auth(manageToken))
        .send({ name: 'كمبو -- مرتجع', basePrice: 15, slots: [{ label: 'الرئيسي', minSelect: 1, maxSelect: 1, options: [{ menuItemId: main.id, extraPrice: 0 }] }] });
      const slot = comboRes.body.slots[0];
      const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(manageToken)).send({ locationId, openingFloat: 100 });

      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set(auth(manageToken))
        .send({
          locationId,
          shiftId: shiftRes.body.id,
          channel: 'DINE_IN',
          lines: [{ comboMealId: comboRes.body.id, quantity: 1, comboSelections: [{ comboSlotId: slot.id, menuItemId: main.id, quantity: 1 }] }],
        });
      await request(app.getHttpServer())
        .post(`/orders/${orderRes.body.id}/pay`)
        .set(auth(manageToken))
        .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

      const returnableRes = await request(app.getHttpServer()).get(`/returns/order/${orderRes.body.id}/returnable-lines`).set(auth(manageToken));
      expect(returnableRes.status).toBe(200);
      expect(returnableRes.body).toHaveLength(0); // combo line excluded from the returnable list

      const orderLine = await prisma.orderLine.findFirstOrThrow({ where: { orderId: orderRes.body.id } });
      const returnRes = await request(app.getHttpServer())
        .post('/returns')
        .set(auth(manageToken))
        .send({ orderId: orderRes.body.id, reason: 'اختبار', lines: [{ orderLineId: orderLine.id, quantity: 1 }] });
      expect(returnRes.status).toBe(400);
    });
  });
});
