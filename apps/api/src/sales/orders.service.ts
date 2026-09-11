import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceType, OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { CustomersService, EARN_CURRENCY_PER_POINT } from '../customers/customers.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionOrdersService } from '../production/production-orders.service';
import { PromotionsService } from '../promotions/promotions.service';
import { ZatcaService } from '../zatca/zatca.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { HoldOrderDto } from './dto/hold-order.dto';
import { PayOrderDto } from './dto/pay-order.dto';

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

    const menuItemIds = [...new Set(dto.lines.map((l) => l.menuItemId))];
    const menuItems = await this.prisma.menuItem.findMany({ where: { id: { in: menuItemIds } } });
    if (menuItems.length !== menuItemIds.length) {
      throw new BadRequestException('أحد أصناف المنيو المطلوبة غير موجود');
    }
    const inactive = menuItems.find((m) => !m.isActive);
    if (inactive) throw new BadRequestException(`الصنف "${inactive.name}" غير متاح حاليًا`);
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    if (dto.customerId) {
      const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BadRequestException('العميل غير موجود');
    }

    // salesChannelId (a specific price list, e.g. "هنجر ستيشن") is separate
    // from dto.channel (the general dine-in/takeaway/delivery/app
    // classification above, used for promotions/analytics) -- when set,
    // it overrides the unit price used for both the subtotal and every
    // OrderLine below, falling back to each item's base price for any
    // item that has no override on that channel.
    let priceOverrides = new Map<string, number>();
    if (dto.salesChannelId) {
      const channel = await this.prisma.salesChannel.findUnique({ where: { id: dto.salesChannelId } });
      if (!channel || !channel.isActive) throw new BadRequestException('قناة البيع غير موجودة أو غير مفعّلة');
      const overrides = await this.prisma.menuItemChannelPrice.findMany({
        where: { channelId: dto.salesChannelId, menuItemId: { in: menuItemIds } },
      });
      priceOverrides = new Map(overrides.map((o) => [o.menuItemId, Number(o.price)]));
    }
    const effectivePrice = (menuItemId: string) => priceOverrides.get(menuItemId) ?? Number(byId.get(menuItemId)!.price);

    const subtotal = round2(dto.lines.reduce((sum, l) => sum + effectivePrice(l.menuItemId) * l.quantity, 0));

    // A manual discountTotal from the cashier always wins -- the
    // Promotions engine (docs/DECISIONS.md #14, a calculation layer
    // separate from base pricing) only auto-applies when nothing manual
    // was given, and records WHICH promotion fired for audit.
    let discountTotal: number;
    let promotionId: string | null = null;
    if (dto.discountTotal != null) {
      discountTotal = round2(dto.discountTotal);
    } else {
      const applicable = await this.promotions.findApplicablePromotion(dto.channel, subtotal);
      discountTotal = applicable?.discount ?? 0;
      promotionId = applicable?.promotion.id ?? null;
    }
    if (discountTotal > subtotal) throw new BadRequestException('قيمة الخصم أكبر من إجمالي الفاتورة');
    // Per-branch rate (docs/DECISIONS.md #3 originally hardcoded 15% --
    // now Location.vatRate, a percentage e.g. 15.00) so a branch under a
    // different tax jurisdiction isn't stuck with KSA's default.
    const vatRate = Number(location.vatRate) / 100;
    const vatTotal = round2((subtotal - discountTotal) * vatRate);
    const grandTotal = round2(subtotal - discountTotal + vatTotal);

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
          salesChannelId: dto.salesChannelId,
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

      for (const line of dto.lines) {
        const menuItem = byId.get(line.menuItemId)!;
        await tx.orderLine.create({
          data: { orderId: order.id, menuItemId: menuItem.id, quantity: line.quantity, unitPrice: effectivePrice(menuItem.id) },
        });

        // Non-recursive: a menu item's recipe only lists its DIRECT
        // components. If one of those is itself SEMI_FINISHED, we deduct
        // from ITS OWN balance (produced earlier by a Production Order,
        // Phase 6) -- not its sub-ingredients, per
        // docs/ARCHITECTURE.md's "Sales <-> Items <-> Inventory" section.
        const recipeLines = await tx.recipeLine.findMany({ where: { menuItemId: menuItem.id } });
        for (const recipeLine of recipeLines) {
          const { shortfall } = await this.inventory.consume(tx, {
            locationId: dto.locationId,
            ingredientId: recipeLine.ingredientId,
            quantity: Number(recipeLine.quantity) * line.quantity,
            reason: 'SALE',
            refId: order.id,
            allowNegative: location.allowNegativeStock,
          });
          // Only reachable when allowNegativeStock let this sale go
          // through with no real stock behind it -- raises a production
          // need for this shift instead of leaving it as a silent
          // negative InventoryBalance (applyShortfall itself is a no-op
          // for a RAW_MATERIAL, which has no "production" concept).
          if (shortfall > 0) {
            await this.production.applyShortfall(tx, {
              locationId: dto.locationId,
              shiftId: dto.shiftId,
              outputIngredientId: recipeLine.ingredientId,
              quantity: shortfall,
            });
          }
        }
      }

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true, promotion: true } });
    });
  }

  async findOne(id: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        lines: { include: { menuItem: { select: { name: true } } } },
        payments: true,
        promotion: true,
        location: {
          select: { name: true, address: true, vatNumber: true, vatRate: true, logoMimeType: true, invoiceHeaderNote: true, invoiceFooterNote: true },
        },
        customer: { select: { name: true, phone: true } },
        servedBy: { select: { id: true, name: true } },
        table: { select: { label: true } },
        activityLog: { orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { name: true } } } },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    return order;
  }

  async findAll(userId: string, locationId?: string, status?: OrderStatus) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.order.findMany({
      where: {
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
        status,
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
      return tx.order.update({ where: { id }, data: { status: OrderStatus.VOIDED }, include: { lines: true } });
    });
  }
}
