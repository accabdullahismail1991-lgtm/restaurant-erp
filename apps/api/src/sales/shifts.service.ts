import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InvoiceType, OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

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
    // Multiple shifts CAN be open at once for the same location (e.g. more
    // than one till/register running concurrently) -- each Shift already
    // tracks its own opening/closing float, orders, and cash reconciliation
    // independently (shiftId FK on Order/Payment), and close()/closeDay()/
    // autoCloseSweep() already loop over every open shift rather than
    // assume a single one, so nothing downstream needed to change to
    // support this. Any number of cashiers can also work under the SAME
    // open shift already (OrdersService.create() only checks location
    // scope, not shift ownership) -- openedById is audit info, not a lock.
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
        invoiceType: true,
        grandTotal: true,
        payments: { select: { method: true, amount: true } },
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
    // Every payment method actually collected at the till this shift (cash,
    // network/card, staff meals, or any other admin-defined method) --
    // separate from invoiceType below, since a method here is "how it was
    // settled" while invoiceType is "what kind of invoice this is" (a
    // CREDIT/deferred invoice, e.g. billed to a delivery-app aggregator,
    // can still be settled through any of these methods at pay() time).
    const byPaymentMethod = new Map<string, number>();
    // CREDIT invoices (docs/DECISIONS.md invoice-type split) tracked apart
    // from the cash-drawer reconciliation above -- typically delivery-app
    // accounts or staff purchases billed to payroll rather than collected
    // in cash/card right now, so a shift-closer needs this called out on
    // its own rather than buried inside byPaymentMethod.
    let creditInvoiceTotal = 0;
    let itemCount = 0;

    for (const order of orders) {
      const channelKey = order.channel;
      const channelEntry = byChannel.get(channelKey) ?? { orderCount: 0, revenue: 0 };
      channelEntry.orderCount += 1;
      channelEntry.revenue += Number(order.grandTotal);
      byChannel.set(channelKey, channelEntry);

      for (const payment of order.payments) {
        byPaymentMethod.set(payment.method, (byPaymentMethod.get(payment.method) ?? 0) + Number(payment.amount));
      }
      if (order.invoiceType === InvoiceType.CREDIT) {
        creditInvoiceTotal += Number(order.grandTotal);
      }

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
      byPaymentMethod: [...byPaymentMethod.entries()]
        .map(([method, amount]) => ({ method, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      creditInvoiceTotal: round2(creditInvoiceTotal),
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

  // Manual "إنهاء اليوم" (end-of-day close) -- a formal record aggregating
  // every shift opened at this location on this calendar date, only once
  // ALL of them are individually closed (the shift-level close() above is
  // still the actual cash reconciliation; this is a rollup on top of it,
  // same "aggregate over already-validated rows" relationship
  // AnalyticsService's reports have to Shift/Order). One record per
  // (location, date) -- calling this again for the same date just
  // refreshes the same DayClose row's numbers.
  async closeDay(locationId: string, businessDate: string, userId: string) {
    await this.assertLocationInScope(userId, locationId);
    const date = new Date(businessDate);
    if (isNaN(date.getTime())) throw new BadRequestException('تاريخ غير صالح');
    const day = startOfUtcDay(date);
    const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);

    const shifts = await this.prisma.shift.findMany({
      where: { locationId, openedAt: { gte: day, lt: nextDay } },
      select: { id: true, closedAt: true, variance: true, orders: { where: { status: OrderStatus.PAID }, select: { grandTotal: true } } },
    });
    if (!shifts.length) throw new BadRequestException('لا توجد ورديات في هذا التاريخ لهذا الفرع');
    const stillOpen = shifts.filter((s) => !s.closedAt).length;
    if (stillOpen > 0) {
      throw new BadRequestException(`لا يمكن إنهاء اليوم -- يوجد ${stillOpen} وردية لا تزال مفتوحة في هذا التاريخ`);
    }

    return this.upsertDayClose(locationId, day, shifts, userId, false);
  }

  private async upsertDayClose(
    locationId: string,
    day: Date,
    shifts: Array<{ variance: any; orders: Array<{ grandTotal: any }> }>,
    closedById: string | null,
    autoClosed: boolean,
  ) {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const totalRevenue = round2(shifts.reduce((s, sh) => s + sh.orders.reduce((os, o) => os + Number(o.grandTotal), 0), 0));
    const totalVariance = round2(shifts.reduce((s, sh) => s + (sh.variance != null ? Number(sh.variance) : 0), 0));

    return this.prisma.dayClose.upsert({
      where: { locationId_businessDate: { locationId, businessDate: day } },
      create: { locationId, businessDate: day, closedById, autoClosed, shiftsCount: shifts.length, totalRevenue, totalVariance },
      update: { closedById, autoClosed, shiftsCount: shifts.length, totalRevenue, totalVariance, closedAt: new Date() },
    });
  }

  async listDayCloses(userId: string, locationId?: string, from?: string, to?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    const gte = from ? new Date(from) : undefined;
    const lte = to ? new Date(to) : undefined;
    return this.prisma.dayClose.findMany({
      where: {
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
        businessDate: gte || lte ? { gte, lte } : undefined,
      },
      include: { location: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
      orderBy: { businessDate: 'desc' },
    });
  }

  // Settlement gate for OrdersService.create() (القرار: no new invoice while
  // yesterday's till is still open) -- two distinct problems, reported and
  // blocked separately: (1) a shift opened before today that's still open
  // (nobody reconciled the till), and (2) a calendar day whose shifts are
  // ALL closed but no DayClose rollup was ever made for it (nobody hit
  // "إنهاء اليوم"). A day with an open stale shift only shows up in (1) --
  // once that shift is closed it falls into (2) until closeDay() runs.
  private async buildSettlementStatus(locationId: string, lookbackDays = 31) {
    const today = startOfUtcDay(new Date());
    const lookbackStart = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const openShifts = await this.prisma.shift.findMany({
      where: { locationId, closedAt: null, openedAt: { lt: today } },
      select: { id: true, shiftNumber: true, openedAt: true, openedBy: { select: { name: true } } },
      orderBy: { openedAt: 'asc' },
    });

    const shiftsInWindow = await this.prisma.shift.findMany({
      where: { locationId, openedAt: { gte: lookbackStart, lt: today } },
      select: { openedAt: true, closedAt: true },
    });
    const dayMap = new Map<number, boolean>(); // day (ms) -> has an open shift that day
    for (const s of shiftsInWindow) {
      const dayMs = startOfUtcDay(s.openedAt).getTime();
      dayMap.set(dayMs, (dayMap.get(dayMs) ?? false) || !s.closedAt);
    }
    const fullyClosedDays = [...dayMap.entries()].filter(([, hasOpen]) => !hasOpen).map(([ms]) => new Date(ms));
    const existingCloses = fullyClosedDays.length
      ? await this.prisma.dayClose.findMany({
          where: { locationId, businessDate: { in: fullyClosedDays } },
          select: { businessDate: true },
        })
      : [];
    const closedDaySet = new Set(existingCloses.map((c) => c.businessDate.getTime()));
    const unclosedDays = fullyClosedDays
      .filter((d) => !closedDaySet.has(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    return {
      openStaleShifts: openShifts.map((s) => ({
        id: s.id,
        shiftNumber: s.shiftNumber,
        openedAt: s.openedAt,
        openedByName: s.openedBy?.name ?? null,
      })),
      unclosedDays: unclosedDays.map((d) => ({ businessDate: d })),
    };
  }

  async settlementStatus(userId: string, locationId: string) {
    await this.assertLocationInScope(userId, locationId);
    return this.buildSettlementStatus(locationId);
  }

  // Called from OrdersService.create() -- throws a clear, actionable Arabic
  // message rather than letting a new invoice silently land on top of an
  // unsettled yesterday. Location scope is already checked by the caller
  // (OrdersService.assertLocationInScope), so this skips it too.
  async assertNoUnsettledPriorDays(locationId: string) {
    const status = await this.buildSettlementStatus(locationId);
    if (status.openStaleShifts.length > 0) {
      throw new BadRequestException(
        'يوجد ورديات مفتوحة من يوم سابق لم يتم إغلاقها -- يرجى إغلاق جميع الورديات المفتوحة قبل إنشاء فاتورة جديدة',
      );
    }
    if (status.unclosedDays.length > 0) {
      throw new BadRequestException('يوجد يوم عمل سابق لم يتم إنهاؤه -- يرجى إنهاء اليوم (إنهاء اليوم) قبل إنشاء فاتورة جديدة');
    }
  }

  // Forgotten-shift safety net (docs on Location.autoCloseEnabled) -- runs
  // hourly, only touches locations that opted in. A shift with unpaid
  // orders is left alone (same guard close() itself enforces --
  // force-closing past it would silently misstate the till), so a location
  // with a genuinely stuck shift still needs a human, it just won't block
  // every OTHER location's auto-close from running.
  @Cron('0 * * * *')
  async autoCloseSweep() {
    const now = new Date();
    const locations = await this.prisma.location.findMany({ where: { isActive: true, autoCloseEnabled: true } });
    for (const location of locations) {
      if (now.getUTCHours() < location.autoCloseCutoffHour) continue;
      await this.autoCloseLocationShifts(location.id, now);
    }
  }

  // Split out from the cron so a manual "run auto-close now" trigger and
  // tests can exercise the exact same logic without waiting for the clock,
  // same pattern ReportsService.generateForAllLocations already uses.
  async autoCloseLocationShifts(locationId: string, now: Date) {
    const today = startOfUtcDay(now);
    const openShifts = await this.prisma.shift.findMany({ where: { locationId, closedAt: null } });
    const staleShifts = openShifts.filter((s) => startOfUtcDay(s.openedAt).getTime() < today.getTime());
    if (!staleShifts.length) return { closedCount: 0, skippedCount: 0 };

    const cashMethodCodes = await this.paymentMethods.cashMethodCodes();
    let closedCount = 0;
    let skippedCount = 0;
    const touchedDays = new Set<number>();
    for (const shift of staleShifts) {
      const unpaidCount = await this.prisma.order.count({
        where: { shiftId: shift.id, status: { notIn: [OrderStatus.PAID, OrderStatus.VOIDED] } },
      });
      if (unpaidCount > 0) {
        skippedCount += 1;
        continue;
      }
      const cashPayments = await this.prisma.payment.aggregate({
        where: { method: { in: cashMethodCodes }, order: { shiftId: shift.id, status: OrderStatus.PAID } },
        _sum: { amount: true },
      });
      const expectedCash = Number(shift.openingFloat) + Number(cashPayments._sum.amount ?? 0);
      await this.prisma.shift.update({
        where: { id: shift.id },
        data: { closingCounted: expectedCash, expectedCash, variance: 0, closedAt: now, closedById: null },
      });
      closedCount += 1;
      touchedDays.add(startOfUtcDay(shift.openedAt).getTime());
    }

    // Every calendar day that just got its last open shift closed, and
    // isn't already end-of-day'd (manually or by a prior sweep), gets an
    // automatic DayClose -- the same "don't leave yesterday hanging
    // forever" guarantee autoCloseEnabled promises for shifts extended to
    // the day rollup on top of them.
    for (const dayMs of touchedDays) {
      const day = new Date(dayMs);
      const nextDay = new Date(dayMs + 24 * 60 * 60 * 1000);
      const dayShifts = await this.prisma.shift.findMany({
        where: { locationId, openedAt: { gte: day, lt: nextDay } },
        select: { closedAt: true, variance: true, orders: { where: { status: OrderStatus.PAID }, select: { grandTotal: true } } },
      });
      if (dayShifts.some((s) => !s.closedAt)) continue;
      await this.upsertDayClose(locationId, day, dayShifts, null, true);
    }

    return { closedCount, skippedCount };
  }
}
