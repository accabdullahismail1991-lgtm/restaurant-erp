import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { CostAdjustmentDto, ReceiveInventoryDto, WasteInventoryDto } from './dto/adjust-inventory.dto';

// Any Prisma client shape that exposes the models this service touches --
// either the real PrismaService (standalone calls, e.g. a manual
// adjustment) or the `tx` handed to a `prisma.$transaction(async (tx) =>
// ...)` callback (e.g. Sales creating an order and consuming stock for it
// atomically -- both succeed or both roll back, per docs/ARCHITECTURE.md's
// "Sales <-> Items <-> Inventory" integration point).
type Db = Pick<PrismaService, 'inventoryBatch' | 'stockMovement' | 'inventoryBalance'>;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async scopedLocationIds(userId: string) {
    return scopedLocationIds(this.prisma, userId);
  }

  async getBalances(userId: string, locationId?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    const where: Prisma.InventoryBalanceWhereInput = locationId
      ? { locationId }
      : allowedIds
        ? { locationId: { in: allowedIds } }
        : {};
    return this.prisma.inventoryBalance.findMany({
      where,
      include: { location: { select: { id: true, name: true } } },
      orderBy: [{ locationId: 'asc' }, { ingredientId: 'asc' }],
    });
  }

  // Adds a new batch (a purchase receipt, a production output, or --
  // for now, before purchasing/production exist -- a manual adjustment)
  // and bumps the derived InventoryBalance to match. Never mutates an
  // existing batch's quantity upward; every addition is its own batch row,
  // per docs/DECISIONS.md #9 (batch tracking mandatory regardless of
  // valuation method).
  async receive(
    db: Db,
    args: { locationId: string; ingredientId: string; quantity: number; unitCost: number; sourceType: string; sourceId?: string; reason: string },
  ) {
    const batch = await db.inventoryBatch.create({
      data: {
        locationId: args.locationId,
        ingredientId: args.ingredientId,
        batchNumber: `${args.sourceType}-${Date.now()}`,
        quantity: args.quantity,
        unitCost: args.unitCost,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
      },
    });
    await db.stockMovement.create({
      data: { batchId: batch.id, quantity: args.quantity, reason: args.reason, refId: args.sourceId },
    });
    await this.bumpBalance(db, args.locationId, args.ingredientId, args.quantity);
    return batch;
  }

  // Depletes `quantity` of `ingredientId` at `locationId` across its open
  // batches, oldest first (FIFO by receivedAt) -- this is a deliberate
  // simplification for both valuation methods: WEIGHTED_AVERAGE ingredients
  // still get a real per-movement cost (the depleted batches' own unitCost),
  // it's just not recomputed into a single rolling average yet. Throws if
  // the location doesn't have enough stock, UNLESS `allowNegative` is set
  // (Location.allowNegativeStock, a per-branch opt-in) -- in which case the
  // shortfall is simply not backed by any real batch: the balance still
  // goes negative (bumpBalance always applies the FULL requested quantity),
  // but the shortfall contributes no cost since there's no real unitCost to
  // attribute it to. Returns the total cost of what it actually depleted
  // (sum of each touched batch's own unitCost x quantity taken from it) --
  // Production uses this to cost the batch it produces from these inputs;
  // Sales and manual waste both just ignore it.
  async consume(db: Db, args: { locationId: string; ingredientId: string; quantity: number; reason: string; refId?: string; allowNegative?: boolean }) {
    let remaining = new Prisma.Decimal(args.quantity);
    const batches = await db.inventoryBatch.findMany({
      where: { locationId: args.locationId, ingredientId: args.ingredientId, quantity: { gt: 0 } },
      orderBy: { receivedAt: 'asc' },
    });

    const consumed: Array<{ batchId: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal }> = [];
    for (const batch of batches) {
      if (remaining.lte(0)) break;
      const take = Prisma.Decimal.min(batch.quantity, remaining);
      consumed.push({ batchId: batch.id, quantity: take, unitCost: batch.unitCost });
      remaining = remaining.sub(take);
    }

    if (remaining.gt(0) && !args.allowNegative) {
      throw new BadRequestException(`رصيد المخزون غير كافٍ للصنف المطلوب (الناقص: ${remaining.toString()})`);
    }

    let totalCost = new Prisma.Decimal(0);
    for (const c of consumed) {
      await db.inventoryBatch.update({ where: { id: c.batchId }, data: { quantity: { decrement: c.quantity } } });
      await db.stockMovement.create({
        data: { batchId: c.batchId, quantity: c.quantity.negated(), reason: args.reason, refId: args.refId },
      });
      totalCost = totalCost.add(c.quantity.mul(c.unitCost));
    }
    await this.bumpBalance(db, args.locationId, args.ingredientId, -args.quantity);
    // Whatever's left in `remaining` here only survived the loop above
    // because allowNegative let it through -- callers that care whether
    // they just sold into stock that doesn't really exist (Sales, to
    // raise a production need) read it from here instead of re-deriving
    // it themselves.
    return { totalCost, shortfall: remaining.gt(0) ? remaining.toNumber() : 0 };
  }

  // Reverses exactly the batch-level movements a prior consume() made for
  // a given refId (e.g. an Order being voided) -- restores the SAME
  // batches it took from, rather than fabricating a new batch at a
  // possibly-different cost. Idempotent: the movements it writes are
  // positive, so calling this twice for the same refId finds nothing to
  // reverse the second time.
  async reverseConsumption(db: Db, args: { refId: string; matchReason: string; restockReason: string }) {
    const movements = await db.stockMovement.findMany({
      where: { refId: args.refId, reason: args.matchReason, quantity: { lt: 0 } },
      include: { batch: true },
    });
    for (const m of movements) {
      const restoreQty = m.quantity.negated();
      await db.inventoryBatch.update({ where: { id: m.batchId }, data: { quantity: { increment: restoreQty } } });
      await db.stockMovement.create({ data: { batchId: m.batchId, quantity: restoreQty, reason: args.restockReason, refId: args.refId } });
      await this.bumpBalance(db, m.batch.locationId, m.batch.ingredientId, Number(restoreQty));
    }
  }

  // Quantity-weighted average cost across an ingredient's currently open
  // batches at a location -- used to value a stocktake variance (there's
  // no single "the" cost once multiple purchase batches at different
  // prices are on the shelf simultaneously). Returns 0 if there's no
  // batch to derive a cost from (e.g. a stocktake "finds" stock for an
  // ingredient that was never formally received there).
  async averageUnitCost(locationId: string, ingredientId: string): Promise<Prisma.Decimal> {
    const batches = await this.prisma.inventoryBatch.findMany({ where: { locationId, ingredientId, quantity: { gt: 0 } } });
    if (!batches.length) return new Prisma.Decimal(0);
    const totalQty = batches.reduce((sum, b) => sum.add(b.quantity), new Prisma.Decimal(0));
    const totalCost = batches.reduce((sum, b) => sum.add(b.quantity.mul(b.unitCost)), new Prisma.Decimal(0));
    return totalCost.div(totalQty);
  }

  private async bumpBalance(db: Db, locationId: string, ingredientId: string, delta: number) {
    await db.inventoryBalance.upsert({
      where: { ingredientId_locationId: { ingredientId, locationId } },
      update: { quantity: { increment: delta } },
      create: { ingredientId, locationId, quantity: delta },
    });
  }

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  async recordReceipt(dto: ReceiveInventoryDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);
    return this.receive(this.prisma, {
      locationId: dto.locationId,
      ingredientId: dto.ingredientId,
      quantity: dto.quantity,
      unitCost: dto.unitCost,
      sourceType: 'ADJUSTMENT',
      reason: 'MANUAL_ADJUSTMENT',
    });
  }

  async recordWaste(dto: WasteInventoryDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);
    return this.consume(this.prisma, {
      locationId: dto.locationId,
      ingredientId: dto.ingredientId,
      quantity: dto.quantity,
      reason: 'WASTE',
    });
  }

  // Revalues every open batch's unitCost to newUnitCost -- deliberately the
  // ONLY inventory-writing path that never touches quantity or writes a
  // StockMovement (that ledger is a quantity trail; a cost-only correction
  // has no quantity delta to record). InventoryBalance similarly stays
  // untouched. Straightforward overwrite rather than a blended average:
  // this is "the recorded cost was wrong, here's the right one", not a
  // partial receipt at a different price (that's what a real PO/receive
  // does, which correctly keeps old and new batches side by side).
  // One-click fix for the "sold/used past zero" debt consume() can leave
  // behind (Location.allowNegativeStock): walks every InventoryBalance
  // currently below zero and receive()s exactly enough to bring it to 0,
  // at that ingredient's current average batch cost -- 0 when (as is
  // normally the case once a balance has actually gone negative; see
  // consume()'s own comment) there's no open batch left to price it from,
  // same as the original shortfall itself carried no cost. Per-item
  // try/catch so one failure doesn't block the rest, same shape as
  // ProductionOrdersService.processReady().
  async settleAllNegativeStock(userId: string, locationId?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    const balances = await this.prisma.inventoryBalance.findMany({
      where: {
        quantity: { lt: 0 },
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
      },
      include: { location: { select: { name: true } } },
    });
    if (!balances.length) return { settledCount: 0, results: [] };

    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: [...new Set(balances.map((b) => b.ingredientId))] } },
      select: { id: true, name: true, unit: true },
    });
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

    const results: Array<{
      ingredientId: string;
      name: string;
      locationId: string;
      locationName: string;
      settled: boolean;
      quantitySettled?: number;
      reason?: string;
    }> = [];
    for (const balance of balances) {
      const ingredient = ingredientById.get(balance.ingredientId);
      const shortfall = -Number(balance.quantity); // positive amount needed to reach 0
      try {
        const unitCost = await this.averageUnitCost(balance.locationId, balance.ingredientId);
        await this.receive(this.prisma, {
          locationId: balance.locationId,
          ingredientId: balance.ingredientId,
          quantity: shortfall,
          unitCost: Number(unitCost),
          sourceType: 'ADJUSTMENT',
          reason: 'NEGATIVE_STOCK_SETTLEMENT',
        });
        results.push({
          ingredientId: balance.ingredientId,
          name: ingredient?.name ?? balance.ingredientId,
          locationId: balance.locationId,
          locationName: balance.location.name,
          settled: true,
          quantitySettled: shortfall,
        });
      } catch (e) {
        results.push({
          ingredientId: balance.ingredientId,
          name: ingredient?.name ?? balance.ingredientId,
          locationId: balance.locationId,
          locationName: balance.location.name,
          settled: false,
          reason: e instanceof Error ? e.message : 'خطأ غير متوقع',
        });
      }
    }
    return { settledCount: results.filter((r) => r.settled).length, results };
  }

  async recordCostAdjustment(dto: CostAdjustmentDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { locationId: dto.locationId, ingredientId: dto.ingredientId, quantity: { gt: 0 } },
    });
    if (!batches.length) {
      throw new BadRequestException('لا يوجد رصيد مخزون حالي لهذا الصنف في هذا الموقع لتسوية تكلفته');
    }
    await this.prisma.inventoryBatch.updateMany({
      where: { id: { in: batches.map((b) => b.id) } },
      data: { unitCost: dto.newUnitCost },
    });
    return {
      ingredientId: dto.ingredientId,
      locationId: dto.locationId,
      batchesUpdated: batches.length,
      totalQuantity: batches.reduce((s, b) => s + Number(b.quantity), 0),
      newUnitCost: dto.newUnitCost,
    };
  }
}
