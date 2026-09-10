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
    return { gte, lte };
  }

  async salesSummary(userId: string, locationId?: string, from?: string, to?: string) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.salesSummaryCore(ids, from, to);
  }

  salesSummaryForLocation(locationId: string | undefined, from?: string, to?: string) {
    return this.salesSummaryCore(locationId ? [locationId] : undefined, from, to);
  }

  private async salesSummaryCore(ids: string[] | undefined, from?: string, to?: string) {
    const { gte, lte } = this.parseRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PAID,
        locationId: ids ? { in: ids } : undefined,
        paidAt: gte || lte ? { gte, lte } : undefined,
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

    return {
      orderCount,
      revenue: round2(revenue),
      netSales: round2(netSales),
      vatCollected: round2(vatCollected),
      discountGiven: round2(discountGiven),
      averageOrderValue: orderCount ? round2(revenue / orderCount) : 0,
      byChannel: [...byChannelMap.entries()].map(([channel, v]) => ({ channel, orderCount: v.orderCount, revenue: round2(v.revenue) })),
    };
  }

  async topItems(userId: string, locationId?: string, from?: string, to?: string, limit = 10) {
    const ids = await this.resolveLocationIds(userId, locationId);
    return this.topItemsCore(ids, from, to, limit);
  }

  topItemsForLocation(locationId: string | undefined, from?: string, to?: string, limit = 20) {
    return this.topItemsCore(locationId ? [locationId] : undefined, from, to, limit);
  }

  private async topItemsCore(ids: string[] | undefined, from?: string, to?: string, limit = 10) {
    const { gte, lte } = this.parseRange(from, to);
    const lines = await this.prisma.orderLine.findMany({
      where: {
        order: {
          status: OrderStatus.PAID,
          locationId: ids ? { in: ids } : undefined,
          paidAt: gte || lte ? { gte, lte } : undefined,
        },
      },
      select: { menuItemId: true, quantity: true, unitPrice: true, menuItem: { select: { name: true } } },
    });

    const byItem = new Map<string, { name: string; quantity: number; revenue: number }>();
    for (const line of lines) {
      const cur = byItem.get(line.menuItemId) ?? { name: line.menuItem.name, quantity: 0, revenue: 0 };
      cur.quantity += line.quantity;
      cur.revenue += Number(line.unitPrice) * line.quantity;
      byItem.set(line.menuItemId, cur);
    }

    return [...byItem.entries()]
      .map(([menuItemId, v]) => ({ menuItemId, name: v.name, quantity: v.quantity, revenue: round2(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
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

  private async menuItemCostsCore(ids: string[] | undefined) {
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
    const avgCost = (ingredientId: string) => {
      const c = byIngredient.get(ingredientId);
      return c && c.qty > 0 ? c.value / c.qty : 0;
    };

    const items = await this.prisma.menuItem.findMany({
      where: { isActive: true },
      select: { id: true, name: true, price: true, recipe: { select: { ingredientId: true, quantity: true } } },
      orderBy: { name: 'asc' },
    });

    return items.map((item) => {
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
      };
    });
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
      select: { totalAmount: true, status: true, supplier: { select: { name: true } } },
    });

    const committed = pos.filter((po) => AnalyticsService.COMMITTED_PO_STATUSES.includes(po.status));
    const totalSpend = round2(committed.reduce((s, po) => s + Number(po.totalAmount), 0));

    const byStatusMap = new Map<string, number>();
    for (const po of pos) byStatusMap.set(po.status, (byStatusMap.get(po.status) ?? 0) + 1);

    const bySupplierMap = new Map<string, number>();
    for (const po of committed) bySupplierMap.set(po.supplier.name, (bySupplierMap.get(po.supplier.name) ?? 0) + Number(po.totalAmount));

    return {
      orderCount: pos.length,
      totalSpend,
      byStatus: [...byStatusMap.entries()].map(([status, count]) => ({ status, count })),
      topSuppliers: [...bySupplierMap.entries()]
        .map(([supplierName, spend]) => ({ supplierName, spend: round2(spend) }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 10),
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
        const name = l.orderLine.menuItem.name;
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
}
