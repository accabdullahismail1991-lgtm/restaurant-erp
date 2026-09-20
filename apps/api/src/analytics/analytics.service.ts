import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Phase 11 (docs/DECISIONS.md #20): a purely read-only analytical layer
// over the same operational tables every other module already writes --
// nothing here mutates state or adds new tables. Every user-facing report
// is scoped by the SAME location-scope rule every other module uses
// (scopedLocationIds), so a branch manager sees only their own numbers.
//
// Each report is split into a `*Core(ids, ...)` method that takes an
// already-resolved location filter, and a thin public `*(userId, ...)`
// wrapper that resolves it from the caller's scope. The system-level
// report-generation job (ReportsService's cron) calls the *Core methods
// directly with an explicit locationId -- it must NEVER borrow an
// arbitrary user's scope (there is no "current user" for a cron job), so
// it cannot go through the userId-based public methods at all.
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveLocationIds(userId: string, locationId?: string): Promise<string[] | undefined> {
    const allowed = await scopedLocationIds(this.prisma, userId); // null = org-wide (unrestricted)
    if (locationId) {
      if (allowed && !allowed.includes(locationId)) throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
      return [locationId];
    }
    return allowed ?? undefined; // undefined = no filter at all (org-wide + no specific location asked)
  }

  parseRange(from?: string, to?: string): { gte?: Date; lte?: Date } {
    const gte = from ? new Date(from) : undefined;
    const lte = to ? new Date(to) : undefined;
    if (gte && isNaN(gte.getTime())) throw new BadRequestException('تاريخ البداية (from) غير صالح');
    if (lte && isNaN(lte.getTime())) throw new BadRequestException('تاريخ النهاية (to) غير صالح');
    // Every caller passes `to` as a plain "YYYY-MM-DD" (the UI's own <input
    // type=date>) meaning "through the end of that day" -- parsed as-is
    // that's midnight, the very FIRST instant of the day, so an `lte`
    // bound built from it would exclude almost everything that actually
    // happened that day. Most visibly wrong for a "today" default
    // (from=to=today): it would show today's own report as empty.
    if (lte) lte.setUTCHours(23, 59, 59, 999);
    return { gte, lte };
  }

  async salesSummary(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.salesSummaryCore(ids, from, to, channel, paymentMethod, customerId);
  }

  salesSummaryForLocation(locationId: string | undefined, from?: string, to?: string) {
    return this.salesSummaryCore(locationId ? [locationId] : undefined, from, to);
  }

  private async salesSummaryCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
        channel,
        customerId,
        payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
      },
      select: { grandTotal: true, subtotal: true, discountTotal: true, vatTotal: true, channel: true },
    });

    const orderCount = orders.length;
    const revenue = orders.reduce((s, o) => s + Number(o.grandTotal), 0);
    const netSales = orders.reduce((s, o) => s + Number(o.subtotal) - Number(o.discountTotal), 0);
    const vatCollected = orders.reduce((s, o) => s + Number(o.vatTotal), 0);
    const discountGiven = orders.reduce((s, o) => s + Number(o.discountTotal), 0);

    const byChannelMap = new Map<string, { orderCount: number; revenue: number }>();
    for (const o of orders) {
      const cur = byChannelMap.get(o.channel) ?? { orderCount: 0, revenue: 0 };
      cur.orderCount += 1;
      cur.revenue += Number(o.grandTotal);
      byChannelMap.set(o.channel, cur);
    }

    // Returns aren't a separate report a manager has to cross-reference --
    // the same period/location filter this report already applies to
    // orders (by paidAt) is reused here on OrderReturn.createdAt, so
    // "revenueAfterReturns" always reflects the exact same window shown.
    const { returnCount, totalRefund } = await this.returnsTotals(ids, gte, lte);

    return {
      orderCount,
      revenue: round2(revenue),
      netSales: round2(netSales),
      vatCollected: round2(vatCollected),
      discountGiven: round2(discountGiven),
      averageOrderValue: orderCount ? round2(revenue / orderCount) : 0,
      byChannel: [...byChannelMap.entries()].map(([channel, v]) => ({ channel, orderCount: v.orderCount, revenue: round2(v.revenue) })),
      returnCount,
      returnsTotal: totalRefund,
      revenueAfterReturns: round2(revenue - totalRefund),
    };
  }

  // Shared by salesSummaryCore (returns shown inline within the sales
  // report) and returnsSummaryCore (the dedicated returns report) -- same
  // underlying OrderReturn rows, same location/date filter shape.
  private async returnsTotals(ids: string[] | undefined, gte?: Date, lte?: Date) {
    const returns = await this.prisma.orderReturn.findMany({
      where: { order: { locationId: ids ? { in: ids } : undefined }, createdAt: gte || lte ? { gte, lte } : undefined },
      select: { refundTotal: true },
    });
    return { returnCount: returns.length, totalRefund: round2(returns.reduce((s, r) => s + Number(r.refundTotal), 0)) };
  }

  // Daily revenue/order-count buckets over the period -- the one shape
  // salesSummaryCore's flat totals can't answer, needed for a trend chart
  // (dashboard line/bar) rather than a single-period snapshot. Same
  // fetch-then-reduce-in-JS style as every other report here; a
  // restaurant's per-period order volume is nowhere near large enough to
  // need a DB-side GROUP BY.
  async salesTrend(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.salesTrendCore(ids, from, to);
  }

  private async salesTrendCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
      },
      select: { paidAt: true, grandTotal: true },
    });

    const byDateMap = new Map<string, { orderCount: number; revenue: number }>();
    for (const o of orders) {
      const date = o.paidAt!.toISOString().slice(0, 10);
      const cur = byDateMap.get(date) ?? { orderCount: 0, revenue: 0 };
      cur.orderCount += 1;
      cur.revenue += Number(o.grandTotal);
      byDateMap.set(date, cur);
    }

    return [...byDateMap.entries()]
      .map(([date, v]) => ({ date, orderCount: v.orderCount, revenue: round2(v.revenue) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // A dedicated "Net Sales" report, the shape a restaurant's finance/ops
  // review actually wants rather than reading it off the general sales
  // summary: gross sales (before discount), net-of-discount sales BOTH
  // excluding and including VAT side by side, distinct customer count (not
  // just order count -- one customer can place several orders), average
  // invoice, and a day-by-day breakdown for the same figures so a trend is
  // visible without opening sales-trend separately.
  async netSales(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.netSalesCore(ids, from, to, channel, paymentMethod, customerId);
  }

  private async netSalesCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
        channel,
        customerId,
        payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
      },
      select: { paidAt: true, subtotal: true, discountTotal: true, vatTotal: true, grandTotal: true, customerId: true },
    });

    const orderCount = orders.length;
    const grossSales = orders.reduce((s, o) => s + Number(o.subtotal), 0);
    const discountGiven = orders.reduce((s, o) => s + Number(o.discountTotal), 0);
    const netSalesExclVat = grossSales - discountGiven;
    const vatTotal = orders.reduce((s, o) => s + Number(o.vatTotal), 0);
    const netSalesInclVat = orders.reduce((s, o) => s + Number(o.grandTotal), 0);
    const customerCount = new Set(orders.map((o) => o.customerId).filter((id): id is string => !!id)).size;
    const walkInOrderCount = orders.filter((o) => !o.customerId).length;

    const byDateMap = new Map<string, { orderCount: number; netSalesExclVat: number; vatTotal: number; netSalesInclVat: number }>();
    for (const o of orders) {
      const date = o.paidAt!.toISOString().slice(0, 10);
      const cur = byDateMap.get(date) ?? { orderCount: 0, netSalesExclVat: 0, vatTotal: 0, netSalesInclVat: 0 };
      cur.orderCount += 1;
      cur.netSalesExclVat += Number(o.subtotal) - Number(o.discountTotal);
      cur.vatTotal += Number(o.vatTotal);
      cur.netSalesInclVat += Number(o.grandTotal);
      byDateMap.set(date, cur);
    }

    return {
      orderCount,
      customerCount,
      walkInOrderCount,
      grossSales: round2(grossSales),
      discountGiven: round2(discountGiven),
      netSalesExclVat: round2(netSalesExclVat),
      vatTotal: round2(vatTotal),
      netSalesInclVat: round2(netSalesInclVat),
      averageInvoiceExclVat: orderCount ? round2(netSalesExclVat / orderCount) : 0,
      averageInvoiceInclVat: orderCount ? round2(netSalesInclVat / orderCount) : 0,
      byDay: [...byDateMap.entries()]
        .map(([date, v]) => ({
          date,
          orderCount: v.orderCount,
          netSalesExclVat: round2(v.netSalesExclVat),
          vatTotal: round2(v.vatTotal),
          netSalesInclVat: round2(v.netSalesInclVat),
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  async topItems(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    limit = 10,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.topItemsCore(ids, from, to, limit, channel, paymentMethod, customerId);
  }

  topItemsForLocation(locationId: string | undefined, from?: string, to?: string, limit = 20) {
    return this.topItemsCore(locationId ? [locationId] : undefined, from, to, limit);
  }

  // Combo-meal lines (menuItemId null) are deliberately excluded here -- a
  // combo has no single "item" to attribute per-unit revenue to, only a
  // composition of slot selections. Their revenue still counts in the
  // aggregate sales totals via salesSummaryCore, which reads Order-level
  // fields and doesn't depend on OrderLine at all.
  private async topItemsCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    limit = 10,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const lines = await this.prisma.orderLine.findMany({
      where: {
        menuItemId: { not: null },
        order: {
          status: OrderStatus.PAID,
          locationId: ids ? { in: ids } : undefined,
          paidAt: gte || lte ? { gte, lte } : undefined,
          channel,
          customerId,
          payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
        },
      },
      select: { menuItemId: true, quantity: true, unitPrice: true, menuItem: { select: { name: true } } },
    });

    const byItem = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const line of lines) {
      const menuItemId = line.menuItemId!;
      const cur = byItem.get(menuItemId) ?? { name: line.menuItem!.name, quantity: 0, revenue: 0 };
      cur.quantity += line.quantity;
      cur.revenue += Number(line.unitPrice) * line.quantity;
      byItem.set(menuItemId, cur);
    }

    return [...byItem.entries()]
      .map(([menuItemId, v]) => ({ menuItemId, name: v.name, quantity: v.quantity, revenue: round2(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  // Detailed sales log: one row per paid invoice, not a summary/breakdown
  // like salesSummaryCore -- this is what "تقرير تفصيلي" actually needs
  // (every invoice, exportable/filterable), same underlying Order rows the
  // KPI cards above already aggregate. Capped at 2000 rows per request --
  // a restaurant's per-location/day order volume is nowhere near that, and
  // an unbounded export isn't a UI a cashier ever needs (they'd narrow the
  // date range instead).
  private static readonly SALES_LOG_MAX_ROWS = 2000;
  async salesLog(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.salesLogCore(ids, from, to, channel, paymentMethod, customerId);
  }

  private async salesLogCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
        channel,
        customerId,
        payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
      },
      select: {
        id: true,
        dailySequence: true,
        shiftSequence: true,
        paidAt: true,
        channel: true,
        invoiceType: true,
        subtotal: true,
        discountTotal: true,
        vatTotal: true,
        grandTotal: true,
        location: { select: { name: true } },
        servedBy: { select: { name: true } },
        customer: { select: { id: true, name: true, phone: true } },
        payments: { select: { method: true, amount: true } },
      },
      orderBy: { paidAt: 'desc' },
      take: AnalyticsService.SALES_LOG_MAX_ROWS,
    });

    return orders.map((o) => ({
      id: o.id,
      dailySequence: o.dailySequence,
      shiftSequence: o.shiftSequence,
      paidAt: o.paidAt,
      locationName: o.location.name,
      cashierName: o.servedBy?.name ?? null,
      customerId: o.customer?.id ?? null,
      customerName: o.customer?.name ?? null,
      customerPhone: o.customer?.phone ?? null,
      channel: o.channel,
      invoiceType: o.invoiceType,
      paymentMethods: [...new Set(o.payments.map((p) => p.method))],
      subtotal: Number(o.subtotal),
      discountTotal: Number(o.discountTotal),
      vatTotal: Number(o.vatTotal),
      grandTotal: Number(o.grandTotal),
    }));
  }

  // Top customers by revenue -- distinct from customerExperienceCore below
  // (which measures SERVICE metrics: repeat rate, service speed, void
  // rate -- never a per-customer money figure). Same "fetch paid orders,
  // reduce in JS" style as every other report here; walk-in orders
  // (customerId null) are excluded since there's no customer to rank.
  async topCustomers(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    limit = 50,
    channel?: string,
    paymentMethod?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.topCustomersCore(ids, from, to, limit, channel, paymentMethod);
  }

  private async topCustomersCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    limit = 50,
    channel?: string,
    paymentMethod?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
        customerId: { not: null },
        channel,
        payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
      },
      select: { customerId: true, grandTotal: true, paidAt: true },
    });

    const byCustomer = new Map<string, { orderCount: number; revenue: number; lastOrderAt: Date }>();
    for (const o of orders) {
      const customerId = o.customerId!;
      const cur = byCustomer.get(customerId) ?? { orderCount: 0, revenue: 0, lastOrderAt: o.paidAt! };
      cur.orderCount += 1;
      cur.revenue += Number(o.grandTotal);
      if (o.paidAt! > cur.lastOrderAt) cur.lastOrderAt = o.paidAt!;
      byCustomer.set(customerId, cur);
    }

    const ranked = [...byCustomer.entries()]
      .map(([customerId, v]) => ({
        customerId,
        orderCount: v.orderCount,
        revenue: round2(v.revenue),
        averageOrderValue: round2(v.revenue / v.orderCount),
        lastOrderAt: v.lastOrderAt,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: ranked.map((r) => r.customerId) } },
      select: { id: true, name: true, phone: true, points: true },
    });
    const customerById = new Map(customers.map((c) => [c.id, c]));

    return ranked.map((r) => ({
      ...r,
      name: customerById.get(r.customerId)?.name ?? null,
      phone: customerById.get(r.customerId)?.phone ?? '',
      points: customerById.get(r.customerId)?.points ?? 0,
    }));
  }

  // ABC/Pareto analysis -- one of the most standard inventory/menu-priority
  // reports in retail & F&B BI: rank every item by revenue, then classify it
  // by where its CUMULATIVE share of total revenue falls -- class A (the
  // items making up the first ~80% of revenue: the vital few to never run
  // out of and to protect margin on), class B (the next ~15%), class C (the
  // long tail, the last ~5%, usually the first candidates for menu pruning).
  // No `limit` unlike topItemsCore -- an item's class depends on its rank
  // among ALL items, so truncating the list first would misclassify it.
  async abcAnalysis(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.abcAnalysisCore(ids, from, to);
  }

  private async abcAnalysisCore(ids: string[] | undefined, from?: string, to?: string) {
    const items = await this.topItemsCore(ids, from, to, Number.MAX_SAFE_INTEGER);
    const totalRevenue = items.reduce((s, i) => s + i.revenue, 0);

    let cumulative = 0;
    const classified = items.map((i) => {
      cumulative += i.revenue;
      const cumulativePercent = totalRevenue > 0 ? round2((cumulative / totalRevenue) * 100) : 0;
      const klass = cumulativePercent <= 80 ? 'A' : cumulativePercent <= 95 ? 'B' : 'C';
      return { ...i, revenuePercent: totalRevenue > 0 ? round2((i.revenue / totalRevenue) * 100) : 0, cumulativePercent, class: klass };
    });

    const countByClass = { A: 0, B: 0, C: 0 };
    const revenueByClass = { A: 0, B: 0, C: 0 };
    for (const i of classified) {
      countByClass[i.class as 'A' | 'B' | 'C'] += 1;
      revenueByClass[i.class as 'A' | 'B' | 'C'] += i.revenue;
    }

    return {
      totalRevenue: round2(totalRevenue),
      items: classified,
      summary: (['A', 'B', 'C'] as const).map((klass) => ({
        class: klass,
        itemCount: countByClass[klass],
        revenue: round2(revenueByClass[klass]),
        revenuePercent: totalRevenue > 0 ? round2((revenueByClass[klass] / totalRevenue) * 100) : 0,
      })),
    };
  }

  // Sales mix by MENU CATEGORY (starters/mains/desserts/...) -- a different
  // axis than topItemsCore's per-item ranking, the one a menu/ops review
  // usually wants first ("which category drives revenue") before drilling
  // into individual items within it.
  async categoryMix(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.categoryMixCore(ids, from, to);
  }

  private async categoryMixCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const lines = await this.prisma.orderLine.findMany({
      where: {
        menuItemId: { not: null },
        order: {
          status: OrderStatus.PAID,
          locationId: ids ? { in: ids } : undefined,
          paidAt: gte || lte ? { gte, lte } : undefined,
        },
      },
      select: { quantity: true, unitPrice: true, menuItem: { select: { category: true } } },
    });

    const byCategory = new Map<string, { quantity: number; revenue: number }>();
    for (const line of lines) {
      const category = line.menuItem!.category;
      const cur = byCategory.get(category) ?? { quantity: 0, revenue: 0 };
      cur.quantity += line.quantity;
      cur.revenue += Number(line.unitPrice) * line.quantity;
      byCategory.set(category, cur);
    }

    const totalRevenue = [...byCategory.values()].reduce((s, v) => s + v.revenue, 0);
    return [...byCategory.entries()]
      .map(([category, v]) => ({
        category,
        quantity: v.quantity,
        revenue: round2(v.revenue),
        revenuePercent: totalRevenue > 0 ? round2((v.revenue / totalRevenue) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  // Period-over-period comparison -- the current window (defaults to the
  // trailing 30 days when no from/to given) against the immediately
  // preceding window of the SAME length, so "how are we doing" always has a
  // like-for-like baseline rather than a bare number with no context.
  async periodComparison(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.periodComparisonCore(ids, from, to);
  }

  private async periodComparisonCore(ids: string[] | undefined, from?: string, to?: string) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const toDate = to ? new Date(to) : new Date();
    if (isNaN(toDate.getTime())) throw new BadRequestException('تاريخ النهاية (to) غير صالح');
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 29 * DAY_MS);
    if (isNaN(fromDate.getTime())) throw new BadRequestException('تاريخ البداية (from) غير صالح');

    const periodDays = Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
    const prevTo = new Date(fromDate.getTime() - DAY_MS);
    const prevFrom = new Date(prevTo.getTime() - (periodDays - 1) * DAY_MS);

    const toStr = (d: Date) => d.toISOString().slice(0, 10);
    const [current, previous] = await Promise.all([
      this.salesSummaryCore(ids, toStr(fromDate), toStr(toDate)),
      this.salesSummaryCore(ids, toStr(prevFrom), toStr(prevTo)),
    ]);

    const pctChange = (curr: number, prev: number) => (prev === 0 ? (curr === 0 ? 0 : 100) : round2(((curr - prev) / prev) * 100));

    return {
      current: { from: toStr(fromDate), to: toStr(toDate), ...current },
      previous: { from: toStr(prevFrom), to: toStr(prevTo), ...previous },
      change: {
        revenue: pctChange(current.revenue, previous.revenue),
        orderCount: pctChange(current.orderCount, previous.orderCount),
        averageOrderValue: pctChange(current.averageOrderValue, previous.averageOrderValue),
        netSales: pctChange(current.netSales, previous.netSales),
      },
    };
  }

  // The standout "advanced BI" report: real Cost of Goods Sold pulled from
  // the ACTUAL batch costs each sale consumed (StockMovement rows with
  // reason='SALE', each tied to the specific InventoryBatch it drew from
  // via InventoryService.consume) -- not an estimate against a recipe's
  // theoretical cost. Food Cost % = COGS / net sales, the standard F&B KPI.
  async foodCost(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.foodCostCore(ids, from, to);
  }

  foodCostForLocation(locationId: string | undefined, from?: string, to?: string) {
    return this.foodCostCore(locationId ? [locationId] : undefined, from, to);
  }

  private async foodCostCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);

    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
      },
      select: { id: true, subtotal: true, discountTotal: true },
    });
    const netSales = orders.reduce((s, o) => s + Number(o.subtotal) - Number(o.discountTotal), 0);
    const orderIds = orders.map((o) => o.id);

    const movements = orderIds.length
      ? await this.prisma.stockMovement.findMany({
          where: { reason: 'SALE', refId: { in: orderIds } },
          select: { quantity: true, batch: { select: { unitCost: true } } },
        })
      : [];
    const cogs = movements.reduce((s, m) => s + Math.abs(Number(m.quantity)) * Number(m.batch.unitCost), 0);

    return {
      netSales: round2(netSales),
      cogs: round2(cogs),
      grossMargin: round2(netSales - cogs),
      foodCostPercent: netSales > 0 ? round2((cogs / netSales) * 100) : 0,
      grossMarginPercent: netSales > 0 ? round2(((netSales - cogs) / netSales) * 100) : 0,
    };
  }

  async inventoryValuation(userId: string, locationId?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.inventoryValuationCore(ids);
  }

  inventoryValuationForLocation(locationId: string | undefined) {
    return this.inventoryValuationCore(locationId ? [locationId] : undefined);
  }

  private async inventoryValuationCore(ids: string[] | undefined) {
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { locationId: ids ? { in: ids } : undefined, quantity: { gt: 0 } },
      select: { ingredientId: true, quantity: true, unitCost: true, ingredient: { select: { name: true, unit: true } } },
    });

    const byIngredient = new Map<string, { name: string; unit: string; quantity: number; value: number }>();
    for (const b of batches) {
      const cur = byIngredient.get(b.ingredientId) ?? { name: b.ingredient.name, unit: b.ingredient.unit, quantity: 0, value: 0 };
      cur.quantity += Number(b.quantity);
      cur.value += Number(b.quantity) * Number(b.unitCost);
      byIngredient.set(b.ingredientId, cur);
    }

    const lines = [...byIngredient.entries()]
      .map(([ingredientId, v]) => ({ ingredientId, name: v.name, unit: v.unit, quantity: round2(v.quantity), value: round2(v.value) }))
      .sort((a, b) => b.value - a.value);

    return { totalValue: round2(lines.reduce((s, l) => s + l.value, 0)), lines };
  }

  async lowStock(userId: string, locationId?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.lowStockCore(ids);
  }

  lowStockForLocation(locationId: string | undefined) {
    return this.lowStockCore(locationId ? [locationId] : undefined);
  }

  private async lowStockCore(ids: string[] | undefined) {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: { locationId: ids ? { in: ids } : undefined },
      select: { ingredientId: true, locationId: true, quantity: true, location: { select: { name: true } } },
    });
    if (!balances.length) return [];

    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: [...new Set(balances.map((b) => b.ingredientId))] } },
      select: { id: true, name: true, unit: true, lowStockThreshold: true },
    });
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

    return balances
      .map((b) => ({ balance: b, ingredient: ingredientById.get(b.ingredientId) }))
      .filter((row) => row.ingredient && Number(row.balance.quantity) <= Number(row.ingredient.lowStockThreshold))
      .map((row) => ({
        ingredientId: row.balance.ingredientId,
        name: row.ingredient!.name,
        unit: row.ingredient!.unit,
        locationId: row.balance.locationId,
        locationName: row.balance.location.name,
        quantity: round2(Number(row.balance.quantity)),
        lowStockThreshold: round2(Number(row.ingredient!.lowStockThreshold)),
      }));
  }

  // A negative InventoryBalance means InventoryService.consume() sold/used
  // past zero (Location.allowNegativeStock) -- real, unbacked debt against
  // real stock. Surfaced separately from lowStockCore above (which compares
  // against each ingredient's OWN threshold and treats 0 or a small
  // positive balance as "low" too) because this report answers a narrower,
  // more urgent question: which balances are actually wrong right now, and
  // by how much, regardless of any threshold. See
  // InventoryService.settleAllNegativeStock() for the matching one-click fix.
  async negativeStock(userId: string, locationId?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.negativeStockCore(ids);
  }

  negativeStockForLocation(locationId: string | undefined) {
    return this.negativeStockCore(locationId ? [locationId] : undefined);
  }

  private async negativeStockCore(ids: string[] | undefined) {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: { locationId: ids ? { in: ids } : undefined, quantity: { lt: 0 } },
      select: { ingredientId: true, locationId: true, quantity: true, location: { select: { name: true } } },
    });
    if (!balances.length) return [];

    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: [...new Set(balances.map((b) => b.ingredientId))] } },
      select: { id: true, name: true, unit: true },
    });
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

    return balances
      .map((b) => ({
        ingredientId: b.ingredientId,
        name: ingredientById.get(b.ingredientId)?.name ?? b.ingredientId,
        unit: ingredientById.get(b.ingredientId)?.unit ?? '',
        locationId: b.locationId,
        locationName: b.location.name,
        quantity: round2(Number(b.quantity)),
      }))
      .sort((a, b) => a.quantity - b.quantity);
  }

  // Per-item theoretical cost -- NOT the same thing as foodCostCore's COGS
  // (that's real consumption from actual sales in a period). This is a
  // live snapshot: "what would this item cost to make right now", from
  // each recipe ingredient's CURRENT weighted-average batch cost --
  // exactly the same real-batch-cost basis inventoryValuationCore already
  // uses, not a separate estimate. A recipe ingredient that is itself a
  // semi-finished item (multi-level BOM, decision #4) doesn't need
  // recursive explosion here: once it's actually been produced at least
  // once, ProductionOrder.complete() already materialized ITS real cost
  // into its own InventoryBatch rows, so looking up its batch cost
  // directly already reflects its true production cost. An ingredient
  // with zero batches (never purchased/produced) costs 0 here -- an
  // honest "no cost data yet", not a crash.
  async menuItemCosts(userId: string, locationId?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.menuItemCostsCore(ids);
  }

  // costOverrides lets a caller substitute a hypothetical unit cost for one
  // or more ingredients instead of each ingredient's real weighted-average
  // batch cost -- the one thing costImpactSimulation below needs that no
  // other caller of this method does, so it's an optional param rather
  // than a second near-duplicate implementation.
  private async menuItemCostsCore(ids: string[] | undefined, costOverrides?: Map<string, number>) {
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { locationId: ids ? { in: ids } : undefined, quantity: { gt: 0 } },
      select: { ingredientId: true, quantity: true, unitCost: true },
    });
    const byIngredient = new Map<string, { qty: number; value: number }>();
    for (const b of batches) {
      const cur = byIngredient.get(b.ingredientId) ?? { qty: 0, value: 0 };
      cur.qty += Number(b.quantity);
      cur.value += Number(b.quantity) * Number(b.unitCost);
      byIngredient.set(b.ingredientId, cur);
    }
    // Ingredient.openingCost (see schema comment) -- a per-unit reference
    // cost entered when the ingredient was defined, read ONLY as a fallback
    // for a line with zero real batches; the moment a real batch exists
    // (even a tiny one), byIngredient above wins and this is never
    // consulted for that ingredient again.
    const openingCosts = await this.prisma.ingredient.findMany({ select: { id: true, openingCost: true } });
    const openingCostById = new Map(openingCosts.map((i) => [i.id, i.openingCost != null ? Number(i.openingCost) : null]));
    let usedOpeningCost = false;
    const avgCost = (ingredientId: string) => {
      if (costOverrides?.has(ingredientId)) return costOverrides.get(ingredientId)!;
      const c = byIngredient.get(ingredientId);
      if (c && c.qty > 0) return c.value / c.qty;
      const opening = openingCostById.get(ingredientId);
      if (opening != null) { usedOpeningCost = true; return opening; }
      return 0;
    };

    const items = await this.prisma.menuItem.findMany({
      where: { isActive: true },
      select: { id: true, name: true, price: true, recipe: { select: { ingredientId: true, quantity: true } } },
      orderBy: { name: 'asc' },
    });

    return items.map((item) => {
      usedOpeningCost = false;
      const cost = round2(item.recipe.reduce((s, l) => s + Number(l.quantity) * avgCost(l.ingredientId), 0));
      const price = round2(Number(item.price));
      return {
        menuItemId: item.id,
        name: item.name,
        price,
        cost,
        costPercent: price > 0 ? round2((cost / price) * 100) : 0,
        grossMargin: round2(price - cost),
        hasRecipe: item.recipe.length > 0,
        // True when at least one recipe line had no real batch data yet and
        // fell back to its ingredient's openingCost -- the admin panel
        // shows this as "تقديرية" rather than presenting it as a real
        // weighted-average cost.
        costIsEstimated: usedOpeningCost,
      };
    });
  }

  // Menu engineering (Kasavana & Smith matrix) -- the standard F&B
  // classification of every item actually sold in a period along two axes:
  // popularity (its share of total units sold) and profitability (its
  // contribution margin vs. the period's own volume-weighted average
  // margin). An item is "popular" once its share reaches 70% of what an
  // even split across all sold items would give it (the standard "70%
  // rule": popularityThreshold = (1/itemCount) * 0.7) -- a deliberately
  // lower bar than "above average" so a menu with many items doesn't
  // brand almost everything a dog. Combines two existing reports
  // (topItemsCore for real sales volume in the period, menuItemCostsCore
  // for the live cost basis) rather than a new query -- an item's
  // classification is a property of ITS sales row plus its live cost
  // snapshot, not a new fact to compute from raw tables.
  async menuEngineering(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.menuEngineeringCore(ids, from, to);
  }

  private async menuEngineeringCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    costOverrides?: Map<string, number>,
  ) {
    const [soldItems, costs] = await Promise.all([
      this.topItemsCore(ids, from, to, 100000),
      this.menuItemCostsCore(ids, costOverrides),
    ]);
    const costByItem = new Map(costs.map((c) => [c.menuItemId, c]));

    const totalQuantity = soldItems.reduce((s, i) => s + i.quantity, 0);
    const totalMarginWeighted = soldItems.reduce((s, i) => {
      const c = costByItem.get(i.menuItemId);
      return s + (c ? c.price - c.cost : 0) * i.quantity;
    }, 0);
    const avgMargin = totalQuantity > 0 ? totalMarginWeighted / totalQuantity : 0;
    const popularityThreshold = soldItems.length > 0 ? (1 / soldItems.length) * 0.7 : 0;

    const items = soldItems
      .map((i) => {
        const c = costByItem.get(i.menuItemId);
        const price = c ? c.price : 0;
        const cost = c ? c.cost : 0;
        const margin = round2(price - cost);
        const popularityPercent = totalQuantity > 0 ? i.quantity / totalQuantity : 0;
        const isPopular = popularityPercent >= popularityThreshold;
        const isProfitable = margin >= avgMargin;
        const classification: 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG' = isPopular
          ? (isProfitable ? 'STAR' : 'PLOWHORSE')
          : (isProfitable ? 'PUZZLE' : 'DOG');
        return {
          menuItemId: i.menuItemId,
          name: i.name,
          quantity: i.quantity,
          revenue: i.revenue,
          price,
          cost,
          margin,
          marginPercent: price > 0 ? round2((margin / price) * 100) : 0,
          popularityPercent: round2(popularityPercent * 100),
          classification,
        };
      })
      .sort((a, b) => b.quantity - a.quantity);

    return {
      avgMargin: round2(avgMargin),
      popularityThresholdPercent: round2(popularityThreshold * 100),
      counts: {
        STAR: items.filter((i) => i.classification === 'STAR').length,
        PLOWHORSE: items.filter((i) => i.classification === 'PLOWHORSE').length,
        PUZZLE: items.filter((i) => i.classification === 'PUZZLE').length,
        DOG: items.filter((i) => i.classification === 'DOG').length,
      },
      items,
    };
  }

  // "What if ingredient X's cost changes" -- runs the exact same
  // menuEngineeringCore classification twice (once with real batch costs,
  // once substituting the hypothetical new unit costs via costOverrides)
  // over the same sales period, so every menu item's cost/margin/
  // classification shift is a straight diff of two real reports rather
  // than a parallel estimate that could drift from how menuEngineering
  // actually classifies items.
  async costImpactSimulation(
    userId: string,
    ingredientChanges: Array<{ ingredientId: string; newUnitCost: number }>,
    locationId?: string,
    from?: string,
    to?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    const costOverrides = new Map(ingredientChanges.map((c) => [c.ingredientId, c.newUnitCost]));
    const [baseline, simulated] = await Promise.all([
      this.menuEngineeringCore(ids, from, to),
      this.menuEngineeringCore(ids, from, to, costOverrides),
    ]);
    const simulatedByItem = new Map(simulated.items.map((i) => [i.menuItemId, i]));

    const affectedIngredientIds = new Set(ingredientChanges.map((c) => c.ingredientId));
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: [...affectedIngredientIds] } },
      select: { id: true, name: true },
    });
    const ingredientNames = new Map(ingredients.map((i) => [i.id, i.name]));

    const items = baseline.items
      .map((before) => {
        const after = simulatedByItem.get(before.menuItemId);
        if (!after) return null;
        return {
          menuItemId: before.menuItemId,
          name: before.name,
          currentCost: before.cost,
          simulatedCost: after.cost,
          costDelta: round2(after.cost - before.cost),
          currentMargin: before.margin,
          simulatedMargin: after.margin,
          marginDelta: round2(after.margin - before.margin),
          currentClassification: before.classification,
          simulatedClassification: after.classification,
          classificationChanged: before.classification !== after.classification,
        };
      })
      .filter((i): i is NonNullable<typeof i> => i !== null && i.costDelta !== 0)
      .sort((a, b) => Math.abs(b.marginDelta) - Math.abs(a.marginDelta));

    return {
      changedIngredients: ingredientChanges.map((c) => ({
        ingredientId: c.ingredientId,
        name: ingredientNames.get(c.ingredientId) ?? c.ingredientId,
        newUnitCost: round2(c.newUnitCost),
      })),
      classificationShiftCount: items.filter((i) => i.classificationChanged).length,
      items,
    };
  }

  // Purchasing spend by supplier -- only these downstream statuses count
  // as real committed spend; DRAFT/REJECTED/CANCELLED never happened
  // financially, so a report that included them would overstate what was
  // actually spent.
  private static readonly COMMITTED_PO_STATUSES = ['APPROVED', 'SENT_TO_SUPPLIER', 'RECEIVED'];

  async purchasingSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.purchasingSummaryCore(ids, from, to);
  }

  private async purchasingSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const pos = await this.prisma.purchaseOrder.findMany({
      where: { locationId: ids ? { in: ids } : undefined, createdAt: gte || lte ? { gte, lte } : undefined },
      select: { totalAmount: true, vatTotal: true, status: true, supplier: { select: { name: true } } },
    });

    const committed = pos.filter((po) => AnalyticsService.COMMITTED_PO_STATUSES.includes(po.status));
    const totalSpend = round2(committed.reduce((s, po) => s + Number(po.totalAmount), 0));
    // Real input VAT captured per PO at creation (PurchaseOrder.vatTotal --
    // see PurchaseOrdersService.create), from each line's own taxType and
    // the PO's own pricesIncludeVat flag matching that supplier's invoice
    // format. No longer an estimate/guess off the branch's flat vatRate.
    const vatTotal = round2(committed.reduce((s, po) => s + Number(po.vatTotal), 0));

    const byStatusMap = new Map<string, number>();
    for (const po of pos) byStatusMap.set(po.status, (byStatusMap.get(po.status) ?? 0) + 1);

    const bySupplierMap = new Map<string, number>();
    for (const po of committed) bySupplierMap.set(po.supplier.name, (bySupplierMap.get(po.supplier.name) ?? 0) + Number(po.totalAmount));

    return {
      orderCount: pos.length,
      totalSpend,
      vatTotal,
      byStatus: [...byStatusMap.entries()].map(([status, count]) => ({ status, count })),
      topSuppliers: [...bySupplierMap.entries()]
        .map(([supplierName, spend]) => ({ supplierName, spend: round2(spend) }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 10),
    };
  }

  // Combines both sides of VAT the restaurant deals with -- output tax
  // collected on sales (Order.vatTotal, computed per-line off each item's
  // taxType in OrdersService.create()) and input tax paid on purchasing
  // (PurchaseOrder.vatTotal, computed per-line off each line's taxType and
  // the PO's own pricesIncludeVat flag in PurchaseOrdersService.create()) --
  // both are real captured figures now, not estimates. The by-tax-type
  // sales split reads each line's CURRENT menuItem.taxType (not a
  // historical snapshot -- same simplification menuItemCosts/foodCost
  // already make elsewhere in this file), so changing an item's tax type
  // reclassifies its past lines here too.
  async taxSummary(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.taxSummaryCore(ids, from, to, channel, paymentMethod, customerId);
  }

  private async taxSummaryCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
        channel,
        customerId,
        payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
      },
      select: {
        id: true,
        dailySequence: true,
        shiftSequence: true,
        paidAt: true,
        subtotal: true,
        discountTotal: true,
        vatTotal: true,
        grandTotal: true,
        location: { select: { name: true } },
        lines: { select: { quantity: true, unitPrice: true, menuItem: { select: { taxType: true } } } },
      },
      orderBy: { paidAt: 'desc' },
    });

    const salesTaxableSubtotal = round2(orders.reduce((s, o) => s + Number(o.subtotal) - Number(o.discountTotal), 0));
    const salesVatCollected = round2(orders.reduce((s, o) => s + Number(o.vatTotal), 0));

    // Per-invoice and per-day breakdowns -- the summary totals above answer
    // "how much VAT this period", these answer "which invoice/which day"
    // for a VAT filing or an audit trail. Invoices capped like salesLogCore
    // (2000 rows) for the same reason: no UI ever needs an unbounded dump,
    // and a real filing period is narrowed by date anyway.
    const invoices = orders.slice(0, AnalyticsService.SALES_LOG_MAX_ROWS).map((o) => ({
      id: o.id,
      dailySequence: o.dailySequence,
      shiftSequence: o.shiftSequence,
      paidAt: o.paidAt,
      locationName: o.location.name,
      taxableSubtotal: round2(Number(o.subtotal) - Number(o.discountTotal)),
      vatTotal: Number(o.vatTotal),
      grandTotal: Number(o.grandTotal),
    }));
    const byDayMap = new Map<string, { invoiceCount: number; taxableSubtotal: number; vatCollected: number }>();
    for (const o of orders) {
      const day = o.paidAt!.toISOString().slice(0, 10);
      const cur = byDayMap.get(day) ?? { invoiceCount: 0, taxableSubtotal: 0, vatCollected: 0 };
      cur.invoiceCount += 1;
      cur.taxableSubtotal += Number(o.subtotal) - Number(o.discountTotal);
      cur.vatCollected += Number(o.vatTotal);
      byDayMap.set(day, cur);
    }
    const byDay = [...byDayMap.entries()]
      .map(([date, v]) => ({ date, invoiceCount: v.invoiceCount, taxableSubtotal: round2(v.taxableSubtotal), vatCollected: round2(v.vatCollected) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const byTaxTypeMap = new Map<string, number>();
    for (const o of orders) {
      for (const line of o.lines) {
        // A combo line has no menuItem (it's priced as its own bundle) --
        // treated as STANDARD, the same simplification OrdersService.create()
        // itself makes when computing vatTotal.
        const taxType = line.menuItem ? line.menuItem.taxType : 'STANDARD';
        const lineRevenue = Number(line.unitPrice) * line.quantity;
        byTaxTypeMap.set(taxType, (byTaxTypeMap.get(taxType) ?? 0) + lineRevenue);
      }
    }

    const pos = await this.prisma.purchaseOrder.findMany({
      where: { locationId: ids ? { in: ids } : undefined, createdAt: gte || lte ? { gte, lte } : undefined },
      select: { totalAmount: true, vatTotal: true, status: true },
    });
    const committedPos = pos.filter((po) => AnalyticsService.COMMITTED_PO_STATUSES.includes(po.status));
    const purchasingTotalAmount = round2(committedPos.reduce((s, po) => s + Number(po.totalAmount), 0));
    // Real input VAT (PurchaseOrder.vatTotal, from each PO's own
    // pricesIncludeVat + per-line taxType at creation time) -- no longer
    // guessed off the branch's flat vatRate against a tax-blind totalAmount.
    const purchasingVat = round2(committedPos.reduce((s, po) => s + Number(po.vatTotal), 0));

    return {
      sales: {
        taxableSubtotal: salesTaxableSubtotal,
        vatCollected: salesVatCollected,
        grandTotal: round2(orders.reduce((s, o) => s + Number(o.grandTotal), 0)),
        byTaxType: [...byTaxTypeMap.entries()].map(([taxType, revenue]) => ({ taxType, revenue: round2(revenue) })),
        byDay,
        invoices,
      },
      purchasing: {
        totalAmount: purchasingTotalAmount,
        vatTotal: purchasingVat,
      },
      netVatPosition: round2(salesVatCollected - purchasingVat),
    };
  }

  // Refunds and which items customers actually bring back -- the one
  // angle a flat "سجل المرتجعات" history list can't answer on its own.
  async returnsSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.returnsSummaryCore(ids, from, to);
  }

  private async returnsSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const returns = await this.prisma.orderReturn.findMany({
      where: { order: { locationId: ids ? { in: ids } : undefined }, createdAt: gte || lte ? { gte, lte } : undefined },
      select: { refundTotal: true, lines: { select: { quantity: true, orderLine: { select: { menuItem: { select: { name: true } } } } } } },
    });

    const totalRefund = round2(returns.reduce((s, r) => s + Number(r.refundTotal), 0));
    const byItemMap = new Map<string, number>();
    for (const r of returns) {
      for (const l of r.lines) {
        // Combo-line returns are rejected outright in ReturnsService.create(),
        // so menuItem is null here only in theory -- guarded defensively.
        const name = l.orderLine.menuItem?.name;
        if (!name) continue;
        byItemMap.set(name, (byItemMap.get(name) ?? 0) + l.quantity);
      }
    }

    return {
      returnCount: returns.length,
      totalRefund,
      topReturnedItems: [...byItemMap.entries()]
        .map(([name, quantity]) => ({ name, quantity }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10),
    };
  }

  // What goes back OUT to suppliers -- the mirror of returnsSummary above,
  // but valued at what we actually paid (PurchaseReturn.totalAmount is
  // derived from each PurchaseOrderLine's own unitCost, not a blended
  // inventory cost), since this is a credit owed BY a specific supplier.
  async purchaseReturnsSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.purchaseReturnsSummaryCore(ids, from, to);
  }

  private async purchaseReturnsSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const returns = await this.prisma.purchaseReturn.findMany({
      where: { purchaseOrder: { locationId: ids ? { in: ids } : undefined }, createdAt: gte || lte ? { gte, lte } : undefined },
      select: {
        totalAmount: true,
        lines: { select: { quantity: true, purchaseOrderLine: { select: { ingredient: { select: { name: true } } } } } },
      },
    });

    const totalAmount = round2(returns.reduce((s, r) => s + Number(r.totalAmount), 0));
    const byIngredientMap = new Map<string, number>();
    for (const r of returns) {
      for (const l of r.lines) {
        const name = l.purchaseOrderLine.ingredient.name;
        byIngredientMap.set(name, (byIngredientMap.get(name) ?? 0) + Number(l.quantity));
      }
    }

    return {
      returnCount: returns.length,
      totalAmount,
      topReturnedIngredients: [...byIngredientMap.entries()]
        .map(([name, quantity]) => ({ name, quantity }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10),
    };
  }

  // Per-cashier accountability: how many shifts each cashier ran in the
  // window, how much they actually rang up (PAID orders on shifts THEY
  // opened), and their cumulative cash variance -- the number a branch
  // manager actually wants when deciding who to talk to about a shortfall
  // pattern, rather than eyeballing the raw shifts list one row at a time.
  async shiftsSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.shiftsSummaryCore(ids, from, to);
  }

  private async shiftsSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const shifts = await this.prisma.shift.findMany({
      where: { locationId: ids ? { in: ids } : undefined, openedAt: gte || lte ? { gte, lte } : undefined },
      select: {
        closedAt: true,
        variance: true,
        openedBy: { select: { id: true, name: true } },
        orders: { where: { status: OrderStatus.PAID }, select: { grandTotal: true } },
      },
    });

    const byCashierMap = new Map<string, { cashierId: string; cashierName: string; shiftsCount: number; totalSales: number; totalVariance: number }>();
    for (const s of shifts) {
      const cur = byCashierMap.get(s.openedBy.id) ?? {
        cashierId: s.openedBy.id,
        cashierName: s.openedBy.name,
        shiftsCount: 0,
        totalSales: 0,
        totalVariance: 0,
      };
      cur.shiftsCount += 1;
      cur.totalSales += s.orders.reduce((sum, o) => sum + Number(o.grandTotal), 0);
      cur.totalVariance += s.variance !== null ? Number(s.variance) : 0;
      byCashierMap.set(s.openedBy.id, cur);
    }

    return {
      shiftsCount: shifts.length,
      openShiftsCount: shifts.filter((s) => !s.closedAt).length,
      byCashier: [...byCashierMap.values()]
        .map((c) => ({ ...c, totalSales: round2(c.totalSales), totalVariance: round2(c.totalVariance) }))
        .sort((a, b) => b.totalSales - a.totalSales),
    };
  }

  // Revenue split by how customers actually paid -- CASH still needs
  // physical till reconciliation (ShiftsService.close()), CARD/WALLET
  // settle through their own terminal, so seeing the split matters
  // operationally, not just for BI.
  async paymentMethodsSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.paymentMethodsSummaryCore(ids, from, to);
  }

  private async paymentMethodsSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const payments = await this.prisma.payment.findMany({
      where: {
        order: { locationId: ids ? { in: ids } : undefined, status: OrderStatus.PAID },
        createdAt: gte || lte ? { gte, lte } : undefined,
      },
      select: { method: true, amount: true },
    });

    const byMethodMap = new Map<string, { count: number; total: number }>();
    for (const p of payments) {
      const cur = byMethodMap.get(p.method) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(p.amount);
      byMethodMap.set(p.method, cur);
    }

    return {
      totalAmount: round2([...byMethodMap.values()].reduce((s, v) => s + v.total, 0)),
      byMethod: [...byMethodMap.entries()]
        .map(([method, v]) => ({ method, count: v.count, total: round2(v.total) }))
        .sort((a, b) => b.total - a.total),
    };
  }

  // Real cost per output ingredient (ProductionOrder.totalInputCost, captured
  // from the actual batches consumed at start() -- not a recipe estimate),
  // only counted once the order has actually consumed something
  // (IN_PROGRESS or COMPLETED); a still-PLANNED order hasn't touched
  // inventory yet so its totalInputCost is still 0.
  async productionSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.productionSummaryCore(ids, from, to);
  }

  private async productionSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.productionOrder.findMany({
      where: { locationId: ids ? { in: ids } : undefined, createdAt: gte || lte ? { gte, lte } : undefined },
      select: {
        status: true,
        outputQuantity: true,
        totalInputCost: true,
        outputIngredient: { select: { name: true, unit: true } },
      },
    });

    const consumed = orders.filter((o) => o.status === 'IN_PROGRESS' || o.status === 'COMPLETED');
    const totalCost = round2(consumed.reduce((s, o) => s + Number(o.totalInputCost), 0));

    const byOutputMap = new Map<string, { name: string; unit: string; ordersCount: number; totalOutputQuantity: number; totalCost: number }>();
    for (const o of consumed) {
      const key = o.outputIngredient.name;
      const cur = byOutputMap.get(key) ?? { name: o.outputIngredient.name, unit: o.outputIngredient.unit, ordersCount: 0, totalOutputQuantity: 0, totalCost: 0 };
      cur.ordersCount += 1;
      cur.totalOutputQuantity += Number(o.outputQuantity);
      cur.totalCost += Number(o.totalInputCost);
      byOutputMap.set(key, cur);
    }

    const byStatusMap = new Map<string, number>();
    for (const o of orders) byStatusMap.set(o.status, (byStatusMap.get(o.status) ?? 0) + 1);

    return {
      ordersCount: orders.length,
      totalCost,
      byStatus: [...byStatusMap.entries()].map(([status, count]) => ({ status, count })),
      byOutput: [...byOutputMap.values()]
        .map((v) => ({
          ...v,
          totalOutputQuantity: round2(v.totalOutputQuantity),
          totalCost: round2(v.totalCost),
          avgUnitCost: v.totalOutputQuantity > 0 ? round2(v.totalCost / v.totalOutputQuantity) : 0,
        }))
        .sort((a, b) => b.totalCost - a.totalCost),
    };
  }

  // Order volume/revenue bucketed by hour-of-day (0-23, server local time)
  // across the whole date range -- the one shape salesTrend (day buckets)
  // can't answer: WHEN during a typical day business actually happens, to
  // plan staffing/shifts around real peak hours rather than a guess.
  async peakHours(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.peakHoursCore(ids, from, to, channel, paymentMethod, customerId);
  }

  private async peakHoursCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
        channel,
        customerId,
        payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
      },
      select: { paidAt: true, grandTotal: true },
    });

    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orderCount: 0, revenue: 0 }));
    for (const o of orders) {
      const hour = o.paidAt!.getHours();
      byHour[hour].orderCount += 1;
      byHour[hour].revenue += Number(o.grandTotal);
    }
    const withRevenue = byHour.map((h) => ({ ...h, revenue: round2(h.revenue) }));
    const peakHour = withRevenue.reduce((best, h) => (h.orderCount > best.orderCount ? h : best), withRevenue[0]);

    return { byHour: withRevenue, peakHour: peakHour.orderCount > 0 ? peakHour.hour : null };
  }

  // A composite proxy for "customer experience" built entirely from data
  // this system already has -- there's no CSAT/survey table, so this
  // reads signals that correlate with a good/bad experience instead:
  // how many customers come back (loyalty), how fast orders get served,
  // and how often something went wrong (voids/returns).
  async customerExperience(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.customerExperienceCore(ids, from, to, channel, paymentMethod, customerId);
  }

  private async customerExperienceCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const locationFilter = ids ? { in: ids } : undefined;
    const dateFilter = gte || lte ? { gte, lte } : undefined;
    const paymentFilter = paymentMethod ? { some: { method: paymentMethod } } : undefined;

    const [paidOrders, voidedCount, returnsCount] = await Promise.all([
      this.prisma.order.findMany({
        where: { status: OrderStatus.PAID, locationId: locationFilter, paidAt: dateFilter, channel, customerId, payments: paymentFilter },
        select: { customerId: true, createdAt: true, paidAt: true },
      }),
      this.prisma.order.count({ where: { status: OrderStatus.VOIDED, locationId: locationFilter, createdAt: dateFilter, channel, customerId, payments: paymentFilter } }),
      this.prisma.orderReturn.count({ where: { order: { locationId: locationFilter, channel, customerId }, createdAt: dateFilter } }),
    ]);

    const totalOrders = paidOrders.length + voidedCount;
    const ordersWithCustomer = paidOrders.filter((o) => o.customerId);
    const customerOrderCounts = new Map<string, number>();
    for (const o of ordersWithCustomer) customerOrderCounts.set(o.customerId!, (customerOrderCounts.get(o.customerId!) ?? 0) + 1);
    const distinctCustomers = customerOrderCounts.size;
    const repeatCustomers = [...customerOrderCounts.values()].filter((c) => c > 1).length;
    const repeatCustomerRate = distinctCustomers > 0 ? round2((repeatCustomers / distinctCustomers) * 100) : 0;

    // "Order to paid" duration -- a rough service-speed proxy (not prep
    // time specifically; see kitchenPerformance below for that).
    const durationsMs = paidOrders.map((o) => o.paidAt!.getTime() - o.createdAt.getTime()).filter((ms) => ms >= 0);
    const avgServiceMinutes = durationsMs.length ? round2(durationsMs.reduce((s, ms) => s + ms, 0) / durationsMs.length / 60000) : 0;

    const voidRate = totalOrders > 0 ? round2((voidedCount / totalOrders) * 100) : 0;

    return {
      totalOrders,
      distinctCustomersIdentified: distinctCustomers,
      repeatCustomerRate,
      avgServiceMinutes,
      voidedOrders: voidedCount,
      voidRate,
      returnsCount,
    };
  }

  // Kitchen prep-speed report -- order.createdAt -> OrderLine.readyAt per
  // line, distinct from customerExperience's cruder "order to paid" proxy
  // above since a line's readyAt is stamped by KitchenService the moment
  // it's actually marked READY, regardless of when it gets paid.
  async kitchenPerformance(
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.kitchenPerformanceCore(ids, from, to, channel, paymentMethod, customerId);
  }

  private async kitchenPerformanceCore(
    ids: string[] | undefined,
    from?: string,
    to?: string,
    channel?: string,
    paymentMethod?: string,
    customerId?: string,
  ) {
    const { gte, lte } = this.parseRange(from, to);
    const lines = await this.prisma.orderLine.findMany({
      where: {
        readyAt: { not: null },
        order: {
          locationId: ids ? { in: ids } : undefined,
          createdAt: gte || lte ? { gte, lte } : undefined,
          channel,
          customerId,
          payments: paymentMethod ? { some: { method: paymentMethod } } : undefined,
        },
      },
      select: {
        readyAt: true,
        order: { select: { createdAt: true } },
        menuItem: { select: { name: true, category: true } },
        comboMeal: { select: { name: true } },
      },
    });

    const prepMinutes = lines.map((l) => (l.readyAt!.getTime() - l.order.createdAt.getTime()) / 60000).filter((m) => m >= 0);
    const avgPrepMinutes = prepMinutes.length ? round2(prepMinutes.reduce((s, m) => s + m, 0) / prepMinutes.length) : 0;
    const maxPrepMinutes = prepMinutes.length ? round2(Math.max(...prepMinutes)) : 0;

    const byCategoryMap = new Map<string, { totalMinutes: number; count: number }>();
    for (const l of lines) {
      const minutes = (l.readyAt!.getTime() - l.order.createdAt.getTime()) / 60000;
      if (minutes < 0) continue;
      const key = l.menuItem ? l.menuItem.category ?? 'بلا قسم' : 'عروض / كمبو';
      const cur = byCategoryMap.get(key) ?? { totalMinutes: 0, count: 0 };
      cur.totalMinutes += minutes;
      cur.count += 1;
      byCategoryMap.set(key, cur);
    }

    return {
      linesReady: lines.length,
      avgPrepMinutes,
      maxPrepMinutes,
      byCategory: [...byCategoryMap.entries()]
        .map(([category, v]) => ({ category, avgPrepMinutes: round2(v.totalMinutes / v.count), count: v.count }))
        .sort((a, b) => b.avgPrepMinutes - a.avgPrepMinutes),
    };
  }

  // Daily/period consumption per ingredient -- every real stock DEDUCTION
  // is already a StockMovement row (the ledger InventoryService posts
  // instead of ever mutating a balance directly), so this is a read over
  // that same ledger rather than a new tracking mechanism: SALE (recipe
  // consumption at the till), PRODUCTION_CONSUMPTION (an ingredient used as
  // another ingredient's own input), and WASTE (the existing manual
  // waste-recording screen) are the three ways an ingredient's stock goes
  // down that this system already records. STOCKTAKE_ADJUSTMENT is
  // deliberately excluded -- a count correction isn't "consumption", it's
  // fixing the system's belief about what's on the shelf. Each
  // StockMovement is tied to one InventoryBatch, whose unitCost is that
  // batch's REAL cost at the time it was consumed -- summing
  // quantity*unitCost per movement is therefore the actual historical
  // cost of what left the shelf, not a recomputed current-day estimate.
  private static readonly CONSUMPTION_REASONS = ['SALE', 'PRODUCTION_CONSUMPTION', 'WASTE'];
  private static readonly CONSUMPTION_REASON_LABEL: Record<string, string> = {
    SALE: 'مبيعات',
    PRODUCTION_CONSUMPTION: 'إنتاج',
    WASTE: 'هالك',
  };

  async dailyConsumption(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.dailyConsumptionCore(ids, from, to);
  }

  private async dailyConsumptionCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        reason: { in: AnalyticsService.CONSUMPTION_REASONS },
        quantity: { lt: 0 },
        createdAt: gte || lte ? { gte, lte } : undefined,
        batch: { locationId: ids ? { in: ids } : undefined },
      },
      select: {
        quantity: true,
        reason: true,
        batch: { select: { unitCost: true, ingredient: { select: { id: true, name: true, unit: true, kind: true } } } },
      },
    });

    const byIngredient = new Map<
      string,
      { name: string; unit: string; kind: string; qtyByReason: Record<string, number>; costByReason: Record<string, number> }
    >();
    for (const m of movements) {
      const ing = m.batch.ingredient;
      const cur = byIngredient.get(ing.id) ?? {
        name: ing.name,
        unit: ing.unit,
        kind: ing.kind,
        qtyByReason: {},
        costByReason: {},
      };
      const qty = Math.abs(Number(m.quantity));
      const cost = qty * Number(m.batch.unitCost);
      cur.qtyByReason[m.reason] = (cur.qtyByReason[m.reason] ?? 0) + qty;
      cur.costByReason[m.reason] = (cur.costByReason[m.reason] ?? 0) + cost;
      byIngredient.set(ing.id, cur);
    }

    const items = [...byIngredient.entries()]
      .map(([ingredientId, v]) => {
        const totalQty = round2(Object.values(v.qtyByReason).reduce((s, n) => s + n, 0));
        const totalCost = round2(Object.values(v.costByReason).reduce((s, n) => s + n, 0));
        return {
          ingredientId,
          name: v.name,
          unit: v.unit,
          kind: v.kind,
          byReason: AnalyticsService.CONSUMPTION_REASONS.map((reason) => ({
            reason,
            label: AnalyticsService.CONSUMPTION_REASON_LABEL[reason],
            quantity: round2(v.qtyByReason[reason] ?? 0),
            cost: round2(v.costByReason[reason] ?? 0),
          })),
          totalQty,
          totalCost,
        };
      })
      .sort((a, b) => b.totalCost - a.totalCost);

    const totals = {
      totalCost: round2(items.reduce((s, i) => s + i.totalCost, 0)),
      byReason: AnalyticsService.CONSUMPTION_REASONS.map((reason) => ({
        reason,
        label: AnalyticsService.CONSUMPTION_REASON_LABEL[reason],
        cost: round2(items.reduce((s, i) => s + (i.byReason.find((r) => r.reason === reason)?.cost ?? 0), 0)),
      })),
    };

    return { items, totals };
  }
}
