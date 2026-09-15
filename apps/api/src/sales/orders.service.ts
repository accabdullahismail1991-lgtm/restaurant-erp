import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceType, OrderStatus, TaxType } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { userHasPermission } from '../common/permission.util';
import { CustomersService, EARN_CURRENCY_PER_POINT } from '../customers/customers.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrderTypesService } from '../order-types/order-types.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionOrdersService } from '../production/production-orders.service';
import { PromotionsService } from '../promotions/promotions.service';
import { ZatcaService } from '../zatca/zatca.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { HoldOrderDto } from './dto/hold-order.dto';
import { PayOrderDto } from './dto/pay-order.dto';
import { ShiftsService } from './shifts.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly zatca: ZatcaService,
    private readonly promotions: PromotionsService,
    private readonly customers: CustomersService,
    private readonly production: ProductionOrdersService,
    private readonly orderTypes: OrderTypesService,
    private readonly shifts: ShiftsService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  // Creating an order IS the confirmation event in this MVP -- there is no
  // separate "add items then send to kitchen" step yet (that's a natural
  // future enhancement once KDS/Phase 10 needs it), so inventory is
  // deducted for every line right here, atomically with the order itself:
  // docs/ARCHITECTURE.md's "Sales <-> Items <-> Inventory" integration
  // point requires this to be all-or-nothing (a single DB transaction),
  // never "order saved but stock deduction failed".
  async create(dto: CreateOrderDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);

    const location = await this.prisma.location.findUnique({ where: { id: dto.locationId } });
    if (!location) throw new NotFoundException('الموقع غير موجود');
    if (location.requireCustomerForOrders && !dto.customerId) {
      throw new BadRequestException('هذا الفرع يُلزم اختيار العميل عند إنشاء الطلب');
    }
    const invoiceType = dto.invoiceType ?? InvoiceType.CASH;
    // A CREDIT (آجل) invoice is billed to a specific customer's account by
    // definition -- there's no one else to collect it from later.
    if (invoiceType === InvoiceType.CREDIT && !dto.customerId) {
      throw new BadRequestException('الفاتورة الآجلة تتطلب اختيار عميل');
    }

    const shift = await this.prisma.shift.findUnique({ where: { id: dto.shiftId } });
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.locationId !== dto.locationId) throw new BadRequestException('الوردية لا تخص هذا الموقع');
    if (shift.closedAt) throw new BadRequestException('لا يمكن إنشاء طلب على وردية مغلقة');

    // No new invoice while a prior day is unsettled -- a shift left open
    // from before today, or a fully-closed day that never got its "إنهاء
    // اليوم" rollup, must be resolved first (see ShiftsService.
    // assertNoUnsettledPriorDays / GET /shifts/settlement-status for the UI
    // popup listing exactly what's outstanding).
    await this.shifts.assertNoUnsettledPriorDays(dto.locationId);

    // dto.channel references OrderType.code (an admin-manageable table --
    // see order-types module -- replacing the old fixed OrderChannel enum).
    await this.orderTypes.assertActiveCode(dto.channel, 'نوع الطلب');

    // Each line is EITHER a regular menu item OR a combo meal -- exactly
    // one, never both/neither (mirrors OrderLine's own DB-level CHECK
    // constraint, order_line_exactly_one_parent).
    for (const l of dto.lines) {
      if (!!l.menuItemId === !!l.comboMealId) {
        throw new BadRequestException('كل سطر طلب يجب أن يحدد إما صنف منيو أو وجبة كمبو، وليس كليهما أو لا شيء');
      }
    }
    const regularLines = dto.lines.filter((l) => l.menuItemId);
    const comboLines = dto.lines.filter((l) => l.comboMealId);

    const menuItemIds = [...new Set(regularLines.map((l) => l.menuItemId!))];
    const menuItems = menuItemIds.length ? await this.prisma.menuItem.findMany({ where: { id: { in: menuItemIds } } }) : [];
    if (menuItems.length !== menuItemIds.length) {
      throw new BadRequestException('أحد أصناف المنيو المطلوبة غير موجود');
    }
    const inactive = menuItems.find((m) => !m.isActive);
    if (inactive) throw new BadRequestException(`الصنف "${inactive.name}" غير متاح حاليًا`);
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    // Combo meals: validate each line's comboSelections against the
    // combo's own slots (minSelect/maxSelect satisfied, every chosen item
    // is actually one of that slot's options) and compute its per-unit
    // price (basePrice + the chosen options' own extraPrice) -- keyed by
    // the line object itself since a combo could otherwise repeat its
    // comboMealId across multiple distinct lines with different choices.
    const comboMealIds = [...new Set(comboLines.map((l) => l.comboMealId!))];
    const comboMeals = comboMealIds.length
      ? await this.prisma.comboMeal.findMany({ where: { id: { in: comboMealIds } }, include: { slots: { include: { options: true } } } })
      : [];
    if (comboMeals.length !== comboMealIds.length) throw new BadRequestException('أحد وجبات الكمبو المطلوبة غير موجود');
    const inactiveCombo = comboMeals.find((c) => !c.isActive);
    if (inactiveCombo) throw new BadRequestException(`الكمبو "${inactiveCombo.name}" غير متاح حاليًا`);
    const comboById = new Map(comboMeals.map((c) => [c.id, c]));

    const comboLinePrice = new Map<(typeof comboLines)[number], number>();
    const comboSelectedMenuItemIds = new Set<string>();
    for (const line of comboLines) {
      const combo = comboById.get(line.comboMealId!)!;
      const selections = line.comboSelections ?? [];
      const validSlotIds = new Set(combo.slots.map((s) => s.id));
      for (const sel of selections) {
        if (!validSlotIds.has(sel.comboSlotId)) throw new BadRequestException(`فئة اختيار لا تنتمي لكمبو "${combo.name}"`);
      }
      for (const slot of combo.slots) {
        const slotSelections = selections.filter((s) => s.comboSlotId === slot.id);
        const totalQty = slotSelections.reduce((s, x) => s + x.quantity, 0);
        if (totalQty < slot.minSelect || totalQty > slot.maxSelect) {
          throw new BadRequestException(
            `فئة "${slot.label}" في كمبو "${combo.name}" تتطلب اختيار ${slot.minSelect === slot.maxSelect ? slot.minSelect : `بين ${slot.minSelect} و${slot.maxSelect}`} (تم اختيار ${totalQty})`,
          );
        }
        for (const sel of slotSelections) {
          if (!slot.options.some((o) => o.menuItemId === sel.menuItemId)) {
            throw new BadRequestException(`الصنف المختار غير متاح ضمن فئة "${slot.label}" لكمبو "${combo.name}"`);
          }
          comboSelectedMenuItemIds.add(sel.menuItemId);
        }
      }
      const extra = selections.reduce((sum, sel) => {
        const opt = combo.slots.flatMap((s) => s.options).find((o) => o.menuItemId === sel.menuItemId)!;
        return sum + Number(opt.extraPrice) * sel.quantity;
      }, 0);
      comboLinePrice.set(line, round2(Number(combo.basePrice) + extra));
    }
    const comboMenuItems = comboSelectedMenuItemIds.size
      ? await this.prisma.menuItem.findMany({ where: { id: { in: [...comboSelectedMenuItemIds] } } })
      : [];
    const comboMenuItemById = new Map(comboMenuItems.map((m) => [m.id, m]));
    for (const id of comboSelectedMenuItemIds) {
      const item = comboMenuItemById.get(id);
      if (!item) throw new BadRequestException('أحد الأصناف المختارة ضمن الكمبو غير موجود');
      if (!item.isActive) throw new BadRequestException(`الصنف "${item.name}" ضمن الكمبو غير متاح حاليًا`);
    }

    let customer: { defaultSalesChannelId: string | null } | null = null;
    if (dto.customerId) {
      customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BadRequestException('العميل غير موجود');
    }

    // salesChannelId (a specific price list, e.g. "هنجر ستيشن") is separate
    // from dto.channel (the general dine-in/takeaway/delivery/app
    // classification above, used for promotions/analytics) -- when set,
    // it overrides the unit price used for both the subtotal and every
    // OrderLine below, falling back to each item's base price for any
    // item that has no override on that channel. An explicit choice on
    // THIS order always wins; otherwise a customer linked to a default
    // price list (Customer.defaultSalesChannelId) applies automatically --
    // e.g. picking a known delivery-app account applies its own pricing
    // with no extra step from the cashier.
    const effectiveSalesChannelId = dto.salesChannelId ?? customer?.defaultSalesChannelId ?? undefined;
    let priceOverrides = new Map<string, number>();
    if (effectiveSalesChannelId) {
      const channel = await this.prisma.salesChannel.findUnique({ where: { id: effectiveSalesChannelId } });
      if (!channel || !channel.isActive) throw new BadRequestException('قناة البيع غير موجودة أو غير مفعّلة');
      const overrides = await this.prisma.menuItemChannelPrice.findMany({
        where: { channelId: effectiveSalesChannelId, menuItemId: { in: menuItemIds } },
      });
      priceOverrides = new Map(overrides.map((o) => [o.menuItemId, Number(o.price)]));
    }
    const effectivePrice = (menuItemId: string) => priceOverrides.get(menuItemId) ?? Number(byId.get(menuItemId)!.price);

    // Combo pricing (basePrice + chosen options' extraPrice) is
    // deliberately independent of salesChannelId's per-item overrides --
    // a combo's price is its own thing, not derived from its components'
    // channel prices.
    const regularSubtotal = regularLines.reduce((sum, l) => sum + effectivePrice(l.menuItemId!) * l.quantity, 0);
    const comboSubtotal = comboLines.reduce((sum, l) => sum + comboLinePrice.get(l)! * l.quantity, 0);
    const subtotal = round2(regularSubtotal + comboSubtotal);

    // A manual discountTotal from the cashier always wins -- the
    // Promotions engine (docs/DECISIONS.md #14, a calculation layer
    // separate from base pricing) only auto-applies when nothing manual
    // was given, and records WHICH promotion fired for audit. Gated
    // behind pos.apply_discount so a manual discount on the invoice isn't
    // just "whatever the cashier typed" -- a plain cashier still gets
    // whatever the Promotions engine auto-applies, same as before this
    // permission existed.
    let discountTotal: number;
    let promotionId: string | null = null;
    if (dto.discountTotal != null) {
      const canDiscount = await userHasPermission(this.prisma, userId, 'pos.apply_discount');
      if (!canDiscount) throw new ForbiddenException('صلاحية "تطبيق خصم يدوي على فاتورة مبيعات" مطلوبة لتطبيق خصم يدوي');
      discountTotal = round2(dto.discountTotal);
    } else {
      const applicable = await this.promotions.findApplicablePromotion(dto.channel, subtotal);
      discountTotal = applicable?.discount ?? 0;
      promotionId = applicable?.promotion.id ?? null;
    }
    if (discountTotal > subtotal) throw new BadRequestException('قيمة الخصم أكبر من إجمالي الفاتورة');
    // Per-branch rate (docs/DECISIONS.md #3 originally hardcoded 15% --
    // now Location.vatRate, a percentage e.g. 15.00) so a branch under a
    // different tax jurisdiction isn't stuck with KSA's default. Only the
    // STANDARD-rated portion of the subtotal is taxed -- ZERO_RATED/EXEMPT
    // menu items (MenuItem.taxType) contribute 0 VAT regardless of branch
    // rate. Combo meals are priced as one bundled amount with no
    // per-component split, so (like RecipeLine consumption elsewhere in
    // this file) they're simply treated as fully STANDARD-rated. A manual
    // discount is spread pro-rata across the taxable/non-taxable portions
    // rather than assumed to land entirely on one side.
    const taxableRegularSubtotal = regularLines.reduce((sum, l) => {
      const item = byId.get(l.menuItemId!)!;
      return item.taxType === TaxType.STANDARD ? sum + effectivePrice(l.menuItemId!) * l.quantity : sum;
    }, 0);
    const taxableSubtotal = round2(taxableRegularSubtotal + comboSubtotal);
    const vatRate = Number(location.vatRate) / 100;
    const taxableAfterDiscount = subtotal > 0 ? taxableSubtotal - discountTotal * (taxableSubtotal / subtotal) : 0;
    // pricesIncludeVat (docs/DECISIONS.md follow-up): when set, MenuItem.price
    // is already the final price the customer pays -- vatTotal is extracted
    // OUT of taxableAfterDiscount for reporting/ZATCA rather than added on
    // top, so grandTotal never exceeds subtotal-discount (what's on the
    // menu/price list is exactly what's charged). Default (false) is the
    // original behavior: VAT added on top of a tax-exclusive price.
    const vatTotal = location.pricesIncludeVat
      ? round2(taxableAfterDiscount - taxableAfterDiscount / (1 + vatRate))
      : round2(taxableAfterDiscount * vatRate);
    const grandTotal = location.pricesIncludeVat
      ? round2(subtotal - discountTotal)
      : round2(subtotal - discountTotal + vatTotal);

    return this.prisma.$transaction(async (tx) => {
      // Two independent, human-readable invoice numbers -- neither is
      // zatcaInvoiceCounter (Location's official ZATCA chain, never touched
      // here). Both are assigned via a single atomic UPDATE/UPSERT
      // (increment on a row Postgres locks for the update), the same safe
      // pattern ZatcaService already uses for its own counter -- a
      // count-then-insert here would let two orders arriving at the same
      // instant land on the same number.
      const { lastOrderSequence: shiftSequence } = await tx.shift.update({
        where: { id: dto.shiftId },
        data: { lastOrderSequence: { increment: 1 } },
      });
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const { counter: dailySequence } = await tx.dailyInvoiceCounter.upsert({
        where: { locationId_date: { locationId: dto.locationId, date: today } },
        create: { locationId: dto.locationId, date: today, counter: 1 },
        update: { counter: { increment: 1 } },
      });

      const order = await tx.order.create({
        data: {
          locationId: dto.locationId,
          tableId: dto.tableId,
          customerId: dto.customerId,
          shiftId: dto.shiftId,
          channel: dto.channel,
          salesChannelId: effectiveSalesChannelId,
          invoiceType,
          shiftSequence,
          dailySequence,
          status: OrderStatus.SENT_TO_KITCHEN,
          servedById: userId,
          subtotal,
          discountTotal,
          promotionId,
          vatTotal,
          grandTotal,
        },
      });

      // Shared by both regular and combo lines: consume `unitQty * lineQty`
      // of one ingredient's recipe requirement, raising an auto-production
      // order for any shortfall exactly like a plain menu-item sale
      // already does. Non-recursive for the same reason the original
      // comment below explains -- a SEMI_FINISHED component is deducted
      // from ITS OWN produced balance, not exploded into its own BOM.
      const consumeRecipeFor = async (menuItemId: string, lineQty: number) => {
        const recipeLines = await tx.recipeLine.findMany({ where: { menuItemId } });
        for (const recipeLine of recipeLines) {
          const { shortfall } = await this.inventory.consume(tx, {
            locationId: dto.locationId,
            ingredientId: recipeLine.ingredientId,
            quantity: Number(recipeLine.quantity) * lineQty,
            reason: 'SALE',
            refId: order.id,
            allowNegative: location.allowNegativeStock,
          });
          if (shortfall > 0) {
            await this.production.applyShortfall(tx, {
              locationId: dto.locationId,
              shiftId: dto.shiftId,
              outputIngredientId: recipeLine.ingredientId,
              quantity: shortfall,
            });
          }
        }
      };

      for (const line of regularLines) {
        const menuItem = byId.get(line.menuItemId!)!;
        await tx.orderLine.create({
          data: { orderId: order.id, menuItemId: menuItem.id, quantity: line.quantity, unitPrice: effectivePrice(menuItem.id) },
        });
        // Non-recursive: a menu item's recipe only lists its DIRECT
        // components. If one of those is itself SEMI_FINISHED, we deduct
        // from ITS OWN balance (produced earlier by a Production Order,
        // Phase 6) -- not its sub-ingredients, per
        // docs/ARCHITECTURE.md's "Sales <-> Items <-> Inventory" section.
        await consumeRecipeFor(menuItem.id, line.quantity);
      }

      for (const line of comboLines) {
        const orderLine = await tx.orderLine.create({
          data: { orderId: order.id, comboMealId: line.comboMealId, quantity: line.quantity, unitPrice: comboLinePrice.get(line)! },
        });
        const combo = comboById.get(line.comboMealId!)!;
        for (const sel of line.comboSelections ?? []) {
          const opt = combo.slots.flatMap((s) => s.options).find((o) => o.menuItemId === sel.menuItemId)!;
          await tx.comboSelection.create({
            data: {
              orderLineId: orderLine.id,
              comboSlotId: sel.comboSlotId,
              menuItemId: sel.menuItemId,
              quantity: sel.quantity,
              extraPrice: opt.extraPrice,
            },
          });
          // Inventory is consumed against exactly what was chosen, scaled
          // by both how many of that choice within the slot (sel.quantity)
          // AND how many of this combo line were ordered (line.quantity)
          // -- 2x "كمبو عائلي" each choosing 1 side is 2 sides consumed.
          await consumeRecipeFor(sel.menuItemId, sel.quantity * line.quantity);
        }
      }

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true, promotion: true } });
    });
  }

  async findOne(id: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            menuItem: { select: { name: true } },
            comboMeal: { select: { name: true } },
            comboSelections: { include: { menuItem: { select: { name: true } }, comboSlot: { select: { label: true } } } },
          },
        },
        payments: true,
        promotion: true,
        location: {
          select: { name: true, address: true, vatNumber: true, vatRate: true, pricesIncludeVat: true, logoMimeType: true, invoiceHeaderNote: true, invoiceFooterNote: true },
        },
        customer: { select: { name: true, phone: true } },
        servedBy: { select: { id: true, name: true } },
        table: { select: { label: true } },
        shift: { select: { shiftNumber: true } },
        activityLog: { orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { name: true } } } },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    return order;
  }

  async findAll(
    userId: string,
    locationId?: string,
    status?: OrderStatus,
    shiftId?: string,
    servedById?: string,
    from?: string,
    to?: string,
    orderNumber?: string,
  ) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    const gte = from ? new Date(from) : undefined;
    const lte = to ? new Date(new Date(to).setUTCHours(23, 59, 59, 999)) : undefined;
    // A cashier searching "order number" means either the daily sequence
    // (dailySequence, e.g. the #12 printed on today's Nth invoice) or the
    // shift sequence (shiftSequence) -- whichever matches, since neither is
    // globally unique the way Order.id is (that's an internal cuid a
    // cashier never sees or types).
    const orderNumberFilter = orderNumber && !isNaN(Number(orderNumber))
      ? { OR: [{ dailySequence: Number(orderNumber) }, { shiftSequence: Number(orderNumber) }] }
      : {};
    return this.prisma.order.findMany({
      where: {
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
        status,
        shiftId,
        servedById,
        createdAt: gte || lte ? { gte, lte } : undefined,
        ...orderNumberFilter,
      },
      include: {
        servedBy: { select: { id: true, name: true } },
        payments: { select: { method: true, amount: true } },
        _count: { select: { activityLog: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Explicitly parks an unpaid order instead of paying it now -- unlike
  // just "not paid yet" (which doesn't distinguish "cashier hasn't gotten
  // to it" from "deliberately held"), this leaves an audit trail (who,
  // when, optional note) via OrderActivityLog. Status is unchanged; the
  // order stays exactly as payable as before -- ShiftsService.close()
  // is what actually blocks on it remaining unpaid.
  async hold(id: string, dto: HoldOrderDto, userId: string) {
    const order = await this.findOne(id, userId);
    if (order.status === OrderStatus.PAID) throw new BadRequestException('الطلب مدفوع بالفعل، لا يمكن تعليقه');
    if (order.status === OrderStatus.VOIDED) throw new BadRequestException('الطلب ملغى، لا يمكن تعليقه');
    await this.prisma.orderActivityLog.create({ data: { orderId: id, action: 'HELD', note: dto.note, createdById: userId } });
    return this.findOne(id, userId);
  }

  async pay(id: string, dto: PayOrderDto, userId: string) {
    const order = await this.findOne(id, userId);
    if (order.status === OrderStatus.PAID) throw new BadRequestException('الطلب مدفوع بالفعل');
    if (order.status === OrderStatus.VOIDED) throw new BadRequestException('لا يمكن دفع طلب مُلغى');

    const totalPaid = round2(dto.payments.reduce((sum, p) => sum + p.amount, 0));
    if (Math.abs(totalPaid - Number(order.grandTotal)) > 0.01) {
      throw new BadRequestException(`المبلغ المدفوع (${totalPaid}) لا يساوي إجمالي الفاتورة (${order.grandTotal})`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.payment.createMany({
        data: dto.payments.map((p) => ({ orderId: id, method: p.method, mode: p.mode, amount: p.amount, terminalRef: p.terminalRef })),
      });
      await tx.order.update({ where: { id }, data: { status: OrderStatus.PAID, paidAt: new Date() } });
      // Same transaction as the sale itself (docs/DECISIONS.md #3: generated
      // and signed LOCALLY at sale time) -- no-ops if the location has no
      // vatNumber configured, since a missing invoicing setting must never
      // block an actual cash sale.
      await this.zatca.generateForOrder(tx, id);
      // Loyalty (docs/DECISIONS.md #15): earn on PAYMENT, not order creation
      // (an order can still be voided before payment) -- floor() so a sale
      // under the earn threshold simply earns 0, never a fraction.
      if (order.customerId) {
        const points = Math.floor(Number(order.grandTotal) / EARN_CURRENCY_PER_POINT);
        await this.customers.awardPoints(tx, order.customerId, points, 'ORDER_EARN', id);
      }
      return tx.order.findUniqueOrThrow({ where: { id }, include: { lines: true, payments: true, promotion: true } });
    });
  }

  async submitZatca(id: string, userId: string) {
    await this.findOne(id, userId); // scope check + 404 if missing
    return this.zatca.submitToZatca(id);
  }

  // Only reachable before payment -- refunding an already-PAID order is a
  // separate concern (a return/refund flow) out of scope for this phase.
  async void(id: string, userId: string) {
    const order = await this.findOne(id, userId);
    if (order.status === OrderStatus.PAID) throw new BadRequestException('لا يمكن إلغاء طلب مدفوع بالفعل -- يحتاج مسار استرجاع منفصل');
    if (order.status === OrderStatus.VOIDED) throw new BadRequestException('الطلب ملغى بالفعل');

    return this.prisma.$transaction(async (tx) => {
      await this.inventory.reverseConsumption(tx, { refId: id, matchReason: 'SALE', restockReason: 'SALE_VOID_RESTOCK' });
      await tx.orderActivityLog.create({ data: { orderId: id, action: 'VOIDED', createdById: userId } });
      return tx.order.update({ where: { id }, data: { status: OrderStatus.VOIDED }, include: { lines: true } });
    });
  }
}
