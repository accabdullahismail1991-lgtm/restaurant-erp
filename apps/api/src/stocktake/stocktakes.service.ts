import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalRulesService } from '../purchasing/approval-rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';
import { SetStocktakeLinesDto } from './dto/stocktake-lines.dto';
import { CreateStocktakeDto } from './dto/create-stocktake.dto';

const DOCUMENT_TYPE = 'STOCKTAKE_ADJUSTMENT';

@Injectable()
export class StocktakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalRules: ApprovalRulesService,
    private readonly inventory: InventoryService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  // Snapshots each line's systemQuantity from the CURRENT InventoryBalance
  // (0 if the ingredient never had one at this location) and derives its
  // variance -- this is what "compares the theoretical balance to what was
  // physically counted" actually means at the data level.
  private async buildLines(locationId: string, lines: { ingredientId: string; countedQuantity: number }[]) {
    const ids = [...new Set(lines.map((l) => l.ingredientId))];
    const found = await this.prisma.ingredient.findMany({ where: { id: { in: ids } } });
    if (found.length !== ids.length) throw new BadRequestException('أحد الأصناف المطلوبة غير موجود');

    const balances = await this.prisma.inventoryBalance.findMany({
      where: { locationId, ingredientId: { in: ids } },
    });
    const balanceOf = (ingredientId: string) => Number(balances.find((b) => b.ingredientId === ingredientId)?.quantity ?? 0);

    return lines.map((l) => {
      const systemQuantity = balanceOf(l.ingredientId);
      return { ingredientId: l.ingredientId, systemQuantity, countedQuantity: l.countedQuantity, variance: l.countedQuantity - systemQuantity };
    });
  }

  async create(dto: CreateStocktakeDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);
    const lines = await this.buildLines(dto.locationId, dto.lines);

    return this.prisma.stocktake.create({
      data: { locationId: dto.locationId, lines: { create: lines } },
      include: { lines: true },
    });
  }

  async findOne(id: string, userId: string) {
    const stocktake = await this.prisma.stocktake.findUnique({ where: { id }, include: { lines: true, approvals: true } });
    if (!stocktake) throw new NotFoundException('الجرد غير موجود');
    await this.assertLocationInScope(userId, stocktake.locationId);
    return stocktake;
  }

  async findAll(userId: string, locationId?: string, status?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.stocktake.findMany({
      where: { locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined, status },
      orderBy: { startedAt: 'desc' },
    });
  }

  // Recount: replaces the line set with a fresh systemQuantity snapshot
  // (the balance may have moved since the first count) -- only while
  // still IN_PROGRESS, e.g. after a rejection asked for a recount.
  async setLines(id: string, dto: SetStocktakeLinesDto, userId: string) {
    const stocktake = await this.findOne(id, userId);
    if (stocktake.status !== 'IN_PROGRESS') throw new BadRequestException('لا يمكن تعديل عدّ جرد ليس قيد التنفيذ');
    const lines = await this.buildLines(stocktake.locationId, dto.lines);

    return this.prisma.$transaction(async (tx) => {
      await tx.stocktakeLine.deleteMany({ where: { stocktakeId: id } });
      await tx.stocktakeLine.createMany({ data: lines.map((l) => ({ stocktakeId: id, ...l })) });
      return tx.stocktake.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
  }

  // Values every non-zero-variance line at that ingredient's current
  // weighted-average batch cost -- summed as absolute impact (a large
  // shrinkage on one item isn't allowed to hide behind a large phantom
  // gain on another) -- and hands back the per-ingredient cost snapshot
  // used both to decide the Approval Matrix outcome and, if applied right
  // away, to price the adjustment batches with the SAME numbers.
  private async valuation(stocktake: { locationId: string; lines: Array<{ ingredientId: string; variance: unknown }> }) {
    let totalValue = 0;
    const costByIngredientId = new Map<string, number>();
    for (const line of stocktake.lines) {
      const variance = Number(line.variance);
      if (variance === 0) continue;
      const cost = await this.inventory.averageUnitCost(stocktake.locationId, line.ingredientId);
      costByIngredientId.set(line.ingredientId, Number(cost));
      totalValue += Math.abs(variance) * Number(cost);
    }
    return { totalValue, costByIngredientId };
  }

  private async assertHasApprovalRole(locationId: string, totalValue: number, userId: string) {
    const rule = await this.approvalRules.findApplicableRule(DOCUMENT_TYPE, locationId, totalValue);
    if (!rule) return;
    const holdsRole = await this.prisma.userRole.findFirst({ where: { userId, roleId: rule.requiredRoleId } });
    if (!holdsRole) {
      throw new ForbiddenException('لا تملك الدور المطلوب لاعتماد تسوية جرد بهذه القيمة حسب مصفوفة الموافقات');
    }
  }

  private async applyAdjustments(
    tx: Prisma.TransactionClient,
    stocktake: { id: string; locationId: string; lines: Array<{ ingredientId: string; variance: unknown }> },
    costByIngredientId: Map<string, number>,
  ) {
    for (const line of stocktake.lines) {
      const variance = Number(line.variance);
      if (variance === 0) continue;
      if (variance > 0) {
        await this.inventory.receive(tx, {
          locationId: stocktake.locationId,
          ingredientId: line.ingredientId,
          quantity: variance,
          unitCost: costByIngredientId.get(line.ingredientId) ?? 0,
          sourceType: 'STOCKTAKE',
          sourceId: stocktake.id,
          reason: 'STOCKTAKE_ADJUSTMENT',
        });
      } else {
        await this.inventory.consume(tx, {
          locationId: stocktake.locationId,
          ingredientId: line.ingredientId,
          quantity: Math.abs(variance),
          reason: 'STOCKTAKE_ADJUSTMENT',
          refId: stocktake.id,
        });
      }
    }
  }

  // No variance at all -> nothing to approve, straight to APPROVED. A
  // rule covering this location/value -> PENDING_APPROVAL. No rule
  // configured -> auto-approved AND applied immediately, same as
  // Purchasing's submit() when nothing gates it.
  async submit(id: string, userId: string) {
    const stocktake = await this.findOne(id, userId);
    if (stocktake.status !== 'IN_PROGRESS') throw new BadRequestException('الجرد ليس قيد التنفيذ');

    const hasVariance = stocktake.lines.some((l) => Number(l.variance) !== 0);
    if (!hasVariance) {
      return this.prisma.stocktake.update({ where: { id }, data: { status: 'APPROVED', completedAt: new Date() } });
    }

    const { totalValue, costByIngredientId } = await this.valuation(stocktake);
    const rule = await this.approvalRules.findApplicableRule(DOCUMENT_TYPE, stocktake.locationId, totalValue);
    if (rule) {
      return this.prisma.stocktake.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
    }

    return this.prisma.$transaction(async (tx) => {
      await this.applyAdjustments(tx, stocktake, costByIngredientId);
      return tx.stocktake.update({ where: { id }, data: { status: 'APPROVED', completedAt: new Date() }, include: { lines: true } });
    });
  }

  async approve(id: string, dto: ApprovalDecisionDto, userId: string) {
    const stocktake = await this.findOne(id, userId);
    if (stocktake.status !== 'PENDING_APPROVAL') throw new BadRequestException('الجرد ليس بانتظار الموافقة');

    const { totalValue, costByIngredientId } = await this.valuation(stocktake);
    await this.assertHasApprovalRole(stocktake.locationId, totalValue, userId);

    return this.prisma.$transaction(async (tx) => {
      await tx.approval.create({ data: { stocktakeId: id, approvedById: userId, decision: 'APPROVED', note: dto.note } });
      await this.applyAdjustments(tx, stocktake, costByIngredientId);
      return tx.stocktake.update({ where: { id }, data: { status: 'APPROVED', completedAt: new Date() }, include: { lines: true } });
    });
  }

  // Sends it back to IN_PROGRESS for a recount (via setLines) and
  // resubmission -- rejecting a count isn't a terminal state, the
  // schema's status set only ever has IN_PROGRESS/PENDING_APPROVAL/APPROVED.
  async reject(id: string, dto: ApprovalDecisionDto, userId: string) {
    const stocktake = await this.findOne(id, userId);
    if (stocktake.status !== 'PENDING_APPROVAL') throw new BadRequestException('الجرد ليس بانتظار الموافقة');

    const { totalValue } = await this.valuation(stocktake);
    await this.assertHasApprovalRole(stocktake.locationId, totalValue, userId);

    return this.prisma.$transaction(async (tx) => {
      await tx.approval.create({ data: { stocktakeId: id, approvedById: userId, decision: 'REJECTED', note: dto.note } });
      return tx.stocktake.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
    });
  }
}
