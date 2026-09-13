import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  async open(dto: OpenShiftDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);
    // One open shift per location at a time -- cash reconciliation
    // (docs/DECISIONS.md #12) only makes sense against a single till.
    const existingOpen = await this.prisma.shift.findFirst({ where: { locationId: dto.locationId, closedAt: null } });
    if (existingOpen) {
      throw new ConflictException('يوجد وردية مفتوحة بالفعل لهذا الموقع -- يجب إغلاقها أولًا');
    }
    // Same atomic increment-then-use pattern as ZatcaService's invoice
    // counter -- two "فتح وردية" clicks at the exact same instant still get
    // distinct, gap-free SH numbers (Postgres serializes the row update).
    return this.prisma.$transaction(async (tx) => {
      const { lastShiftNumber } = await tx.location.update({
        where: { id: dto.locationId },
        data: { lastShiftNumber: { increment: 1 } },
      });
      return tx.shift.create({
        data: { locationId: dto.locationId, openedById: userId, openingFloat: dto.openingFloat, shiftNumber: lastShiftNumber },
      });
    });
  }

  async findOne(id: string, userId: string) {
    const shift = await this.prisma.shift.findUnique({
      where: { id },
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
    });
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    await this.assertLocationInScope(userId, shift.locationId);
    return shift;
  }

  async findAll(userId: string, locationId?: string, openOnly?: boolean, from?: string, to?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    const gte = from ? new Date(from) : undefined;
    const lte = to ? new Date(new Date(to).setUTCHours(23, 59, 59, 999)) : undefined;
    return this.prisma.shift.findMany({
      where: {
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
        closedAt: openOnly ? null : undefined,
        openedAt: gte || lte ? { gte, lte } : undefined,
      },
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
      orderBy: { openedAt: 'desc' },
    });
  }

  // Cash reconciliation (القرار #12): expected cash = opening float + every
  // payment made in a method flagged isCash (PaymentMethodsService), on a
  // PAID order tied to this shift. Variance = what the cashier actually
  // counted minus that. Only cash-flagged methods are reconciled here --
  // card/wallet/etc settle through their own terminal, not the till.
  async close(id: string, dto: CloseShiftDto, userId: string) {
    const shift = await this.findOne(id, userId);
    if (shift.closedAt) throw new BadRequestException('الوردية مغلقة بالفعل');

    // Every sales invoice tied to this shift must be settled one way or
    // another (paid or voided) before the till can be reconciled and
    // closed -- an order left OPEN/SENT_TO_KITCHEN/READY (including one
    // explicitly "معلّقة/held" via OrdersService.hold()) has no payment
    // recorded yet, so expectedCash below would silently be wrong (missing
    // whatever that sale eventually collects) if closing were allowed
    // regardless.
    const unpaidCount = await this.prisma.order.count({
      where: { shiftId: id, status: { notIn: [OrderStatus.PAID, OrderStatus.VOIDED] } },
    });
    if (unpaidCount > 0) {
      throw new BadRequestException(
        `لا يمكن إغلاق الوردية -- يوجد ${unpaidCount} فاتورة غير مكتملة (غير مدفوعة أو معلّقة) على هذه الوردية، أكمل دفعها أو ألغِها أولًا`,
      );
    }

    const cashMethodCodes = await this.paymentMethods.cashMethodCodes();
    const cashPayments = await this.prisma.payment.aggregate({
      where: { method: { in: cashMethodCodes }, order: { shiftId: id, status: OrderStatus.PAID } },
      _sum: { amount: true },
    });
    const expectedCash = Number(shift.openingFloat) + Number(cashPayments._sum.amount ?? 0);
    const variance = dto.closingCounted - expectedCash;

    return this.prisma.shift.update({
      where: { id },
      data: { closingCounted: dto.closingCounted, expectedCash, variance, closedAt: new Date(), closedById: userId },
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
    });
  }

  // A brief "what happened this shift" recap, meant to print right after
  // closing -- deliberately scoped to just THIS shift's PAID orders (not a
  // date-range report like AnalyticsService.shiftsSummary), so it's
  // available to whoever can close the shift (a plain cashier included),
  // not gated behind analytics.view.
  private static readonly COMBO_CATEGORY_LABEL = 'عروض / كمبو';

  async closeSummary(id: string, userId: string) {
    const shift = await this.findOne(id, userId);
    const orders = await this.prisma.order.findMany({
      where: { shiftId: id, status: OrderStatus.PAID },
      select: {
        channel: true,
        grandTotal: true,
        lines: {
          select: {
            quantity: true,
            unitPrice: true,
            menuItem: { select: { name: true, category: true } },
            comboMeal: { select: { name: true } },
          },
        },
      },
    });

    const byCategory = new Map<string, { quantity: number; revenue: number }>();
    const byItem = new Map<string, { name: string; quantity: number; revenue: number }>();
    const byChannel = new Map<string, { orderCount: number; revenue: number }>();
    let itemCount = 0;

    for (const order of orders) {
      const channelKey = order.channel;
      const channelEntry = byChannel.get(channelKey) ?? { orderCount: 0, revenue: 0 };
      channelEntry.orderCount += 1;
      channelEntry.revenue += Number(order.grandTotal);
      byChannel.set(channelKey, channelEntry);

      for (const line of order.lines) {
        const lineRevenue = Number(line.unitPrice) * line.quantity;
        itemCount += line.quantity;

        const categoryKey = line.menuItem ? line.menuItem.category ?? 'بلا قسم' : ShiftsService.COMBO_CATEGORY_LABEL;
        const categoryEntry = byCategory.get(categoryKey) ?? { quantity: 0, revenue: 0 };
        categoryEntry.quantity += line.quantity;
        categoryEntry.revenue += lineRevenue;
        byCategory.set(categoryKey, categoryEntry);

        // Combo lines are grouped by the combo's own name -- distinct
        // combos sold show as distinct rows, same as distinct menu items.
        const itemName = line.menuItem ? line.menuItem.name : line.comboMeal!.name;
        const itemEntry = byItem.get(itemName) ?? { name: itemName, quantity: 0, revenue: 0 };
        itemEntry.quantity += line.quantity;
        itemEntry.revenue += lineRevenue;
        byItem.set(itemName, itemEntry);
      }
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      shiftId: shift.id,
      shiftNumber: shift.shiftNumber,
      orderCount: orders.length,
      itemCount,
      revenue: round2(orders.reduce((s, o) => s + Number(o.grandTotal), 0)),
      byCategory: [...byCategory.entries()]
        .map(([category, v]) => ({ category, quantity: v.quantity, revenue: round2(v.revenue) }))
        .sort((a, b) => b.revenue - a.revenue),
      byItem: [...byItem.values()]
        .map((v) => ({ name: v.name, quantity: v.quantity, revenue: round2(v.revenue) }))
        .sort((a, b) => b.revenue - a.revenue),
      byChannel: [...byChannel.entries()]
        .map(([channel, v]) => ({ channel, orderCount: v.orderCount, revenue: round2(v.revenue) }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  // A chronological event feed for one shift -- open/close bookends plus
  // every order's own lifecycle (created, paid, held, voided, returned),
  // synthesized from timestamps/fields that already exist rather than a new
  // dedicated log table. Same access rule as closeSummary: available to
  // whoever can view the shift itself, not gated behind analytics.view.
  async activityLog(id: string, userId: string) {
    const shift = await this.findOne(id, userId);
    const orders = await this.prisma.order.findMany({
      where: { shiftId: id },
      select: {
        shiftSequence: true,
        grandTotal: true,
        createdAt: true,
        paidAt: true,
        servedBy: { select: { name: true } },
        activityLog: { select: { action: true, note: true, createdAt: true, createdBy: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    type Event = { type: string; at: Date; by: string | null; orderRef?: number | null; amount?: number; note?: string | null };
    const events: Event[] = [{ type: 'SHIFT_OPENED', at: shift.openedAt, by: shift.openedBy?.name ?? null }];
    for (const order of orders) {
      const orderRef = order.shiftSequence ?? null;
      events.push({ type: 'ORDER_CREATED', at: order.createdAt, by: order.servedBy?.name ?? null, orderRef });
      if (order.paidAt) {
        events.push({ type: 'ORDER_PAID', at: order.paidAt, by: order.servedBy?.name ?? null, orderRef, amount: Number(order.grandTotal) });
      }
      for (const log of order.activityLog) {
        events.push({ type: `ORDER_${log.action}`, at: log.createdAt, by: log.createdBy?.name ?? null, orderRef, note: log.note });
      }
    }
    if (shift.closedAt) {
      events.push({
        type: 'SHIFT_CLOSED',
        at: shift.closedAt,
        by: shift.closedBy?.name ?? null,
        amount: shift.variance != null ? Number(shift.variance) : undefined,
      });
    }
    // Newest first -- same convention the payment dialog's own activity log
    // (order.activityLog orderBy createdAt desc) already uses.
    events.sort((a, b) => b.at.getTime() - a.at.getTime());

    return {
      shift: {
        id: shift.id,
        shiftNumber: shift.shiftNumber,
        locationId: shift.locationId,
        openedAt: shift.openedAt,
        openedBy: shift.openedBy?.name ?? null,
        closedAt: shift.closedAt,
        closedBy: shift.closedBy?.name ?? null,
        openingFloat: Number(shift.openingFloat),
        closingCounted: shift.closingCounted != null ? Number(shift.closingCounted) : null,
        expectedCash: shift.expectedCash != null ? Number(shift.expectedCash) : null,
        variance: shift.variance != null ? Number(shift.variance) : null,
      },
      events,
    };
  }
}
