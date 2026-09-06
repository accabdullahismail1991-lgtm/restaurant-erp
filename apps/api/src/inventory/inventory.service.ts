import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiveInventoryDto, WasteInventoryDto } from './dto/adjust-inventory.dto';

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
  // the location doesn't have enough stock -- no oversell for this
  // online-only phase (offline/negative-balance reconciliation is Phase 8).
  // Returns the total cost of what it actually depleted (sum of each
  // touched batch's own unitCost x quantity taken from it) -- Production
  // uses this to cost the batch it produces from these inputs; Sales and
  // manual waste both just ignore it.
  async consume(db: Db, args: { locationId: string; ingredientId: string; quantity: number; reason: string; refId?: string }) {
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

    if (remaining.gt(0)) {
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
    return { totalCost };
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
}
