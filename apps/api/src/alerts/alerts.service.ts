import { ForbiddenException, Injectable } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;
const EXPIRING_WINDOW_DAYS = 3;

// Every alert here is DERIVED live from existing tables -- no alert ledger
// of its own, deliberately: unlike StockMovement/LoyaltyTransaction (real
// events worth a permanent record), "this ingredient is low" or "this PO
// is waiting" is a fact about CURRENT state, not something that happened
// -- it stops being true the moment the underlying row changes, with
// nothing to reconcile. Not gated behind analytics.view like revenue/
// margin numbers: this is operational awareness (a cashier or branch
// manager needs to see it), same stance /kitchen/queue already takes.
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async getAlerts(userId: string, locationId?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    const ids = locationId ? [locationId] : allowedIds ?? undefined;

    const [lowStock, expiring, pendingPOs, pendingStocktakes] = await Promise.all([
      this.analytics.lowStock(userId, locationId),
      this.expiringBatches(ids),
      this.pendingPurchaseOrders(ids),
      this.pendingStocktakes(ids),
    ]);

    const alerts = [
      ...lowStock.map((r) => ({
        type: 'LOW_STOCK',
        severity: 'warning' as const,
        title: `مخزون منخفض: ${r.name}`,
        detail: `${r.locationName} -- الرصيد ${r.quantity} ${r.unit} (الحد الأدنى ${r.lowStockThreshold})`,
        sortKey: r.quantity, // lower balance first among low-stock rows
      })),
      ...expiring.map((b) => ({
        type: 'EXPIRING_BATCH',
        severity: (b.daysLeft <= 1 ? 'danger' : 'warning') as 'danger' | 'warning',
        title: `صلاحية قريبة: ${b.ingredientName}`,
        detail: `${b.locationName} -- ${b.quantity} ${b.unit}، تنتهي خلال ${b.daysLeft} يوم`,
        sortKey: b.daysLeft,
      })),
      ...pendingPOs.map((po) => ({
        type: 'PO_PENDING_APPROVAL',
        severity: 'info' as const,
        title: 'أمر شراء بانتظار الاعتماد',
        detail: `${po.supplierName} -- ${po.locationName} -- ${po.totalAmount.toFixed(2)}`,
        sortKey: po.createdAt.getTime(),
      })),
      ...pendingStocktakes.map((s) => ({
        type: 'STOCKTAKE_PENDING_APPROVAL',
        severity: 'info' as const,
        title: 'جرد بانتظار الاعتماد',
        detail: s.locationName,
        sortKey: s.startedAt.getTime(),
      })),
    ];

    // Most urgent first: danger, then warning, then info; within each,
    // whichever sortKey makes sense for that type (smallest days-left /
    // balance first, oldest pending approval first).
    const severityRank = { danger: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.sortKey - b.sortKey);
    return alerts.map(({ sortKey: _sortKey, ...alert }) => alert);
  }

  private async expiringBatches(ids?: string[]) {
    const cutoff = new Date(Date.now() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { locationId: ids ? { in: ids } : undefined, quantity: { gt: 0 }, expiresAt: { not: null, lte: cutoff } },
      include: { ingredient: true, location: true },
      orderBy: { expiresAt: 'asc' },
    });
    return batches.map((b) => ({
      ingredientName: b.ingredient.name,
      unit: b.ingredient.unit,
      locationName: b.location.name,
      quantity: round2(Number(b.quantity)),
      daysLeft: Math.max(0, Math.ceil((b.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000))),
    }));
  }

  private async pendingPurchaseOrders(ids?: string[]) {
    const pos = await this.prisma.purchaseOrder.findMany({
      where: { locationId: ids ? { in: ids } : undefined, status: 'PENDING_APPROVAL' },
      include: { supplier: true, location: true },
    });
    return pos.map((po) => ({
      supplierName: po.supplier.name,
      locationName: po.location.name,
      totalAmount: Number(po.totalAmount),
      createdAt: po.createdAt,
    }));
  }

  private async pendingStocktakes(ids?: string[]) {
    const stocktakes = await this.prisma.stocktake.findMany({
      where: { locationId: ids ? { in: ids } : undefined, status: 'PENDING_APPROVAL' },
      include: { location: true },
    });
    return stocktakes.map((s) => ({ locationName: s.location.name, startedAt: s.startedAt }));
  }
}
