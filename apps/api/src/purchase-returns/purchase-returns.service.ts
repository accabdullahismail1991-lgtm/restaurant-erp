import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { POStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePurchaseReturnDto } from './dto/create-purchase-return.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Mirrors ReturnsService (customer returns) almost line for line, but in
// the opposite inventory direction: a customer return RECEIVES stock back
// in, a purchase return CONSUMES stock back out (it's leaving to go back
// to the supplier). Only ever against a RECEIVED purchase order -- that's
// the only status where the goods actually entered inventory in the first
// place (purchase-orders.service.ts's receive()).
@Injectable()
export class PurchaseReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  // What's left returnable per line of a given PO -- original quantity
  // received minus whatever was already returned across any PRIOR
  // PurchaseReturn for the same line.
  async returnableLines(purchaseOrderId: string, userId: string) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { lines: { include: { ingredient: true } } },
    });
    if (!po) throw new NotFoundException('أمر الشراء غير موجود');
    await this.assertLocationInScope(userId, po.locationId);
    if (po.status !== POStatus.RECEIVED) {
      throw new BadRequestException('لا يمكن عمل مرتجع مورد إلا لأمر شراء تم استلامه فعليًا');
    }

    const priorLines = await this.prisma.purchaseReturnLine.findMany({
      where: { purchaseOrderLineId: { in: po.lines.map((l) => l.id) } },
    });
    const returnedByLine = new Map<string, number>();
    for (const p of priorLines) returnedByLine.set(p.purchaseOrderLineId, (returnedByLine.get(p.purchaseOrderLineId) || 0) + Number(p.quantity));

    return po.lines.map((l) => ({
      purchaseOrderLineId: l.id,
      ingredientId: l.ingredientId,
      ingredientName: l.ingredient.name,
      unit: l.ingredient.unit,
      unitCost: l.unitCost,
      quantity: l.quantity,
      alreadyReturned: returnedByLine.get(l.id) || 0,
      remaining: Number(l.quantity) - (returnedByLine.get(l.id) || 0),
    }));
  }

  async create(dto: CreatePurchaseReturnDto, userId: string) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id: dto.purchaseOrderId }, include: { lines: true } });
    if (!po) throw new NotFoundException('أمر الشراء غير موجود');
    await this.assertLocationInScope(userId, po.locationId);
    if (po.status !== POStatus.RECEIVED) {
      throw new BadRequestException('لا يمكن عمل مرتجع مورد إلا لأمر شراء تم استلامه فعليًا');
    }

    const lineIds = dto.lines.map((l) => l.purchaseOrderLineId);
    const poLines = po.lines.filter((l) => lineIds.includes(l.id));
    if (poLines.length !== new Set(lineIds).size) {
      throw new BadRequestException('أحد سطور أمر الشراء غير موجود في هذا الأمر');
    }

    const priorLines = await this.prisma.purchaseReturnLine.findMany({ where: { purchaseOrderLineId: { in: lineIds } } });
    const returnedByLine = new Map<string, number>();
    for (const p of priorLines) returnedByLine.set(p.purchaseOrderLineId, (returnedByLine.get(p.purchaseOrderLineId) || 0) + Number(p.quantity));

    let totalAmount = 0;
    const computed = dto.lines.map((l) => {
      const poLine = poLines.find((pl) => pl.id === l.purchaseOrderLineId)!;
      const already = returnedByLine.get(l.purchaseOrderLineId) || 0;
      if (already + l.quantity > Number(poLine.quantity)) {
        throw new BadRequestException('الكمية المطلوب إرجاعها للمورد أكبر من المتبقي القابل للإرجاع لهذا الصنف');
      }
      const amount = round2(l.quantity * Number(poLine.unitCost));
      totalAmount += amount;
      return { poLine, quantity: l.quantity, amount };
    });
    totalAmount = round2(totalAmount);

    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.purchaseReturn.create({
        data: { purchaseOrderId: po.id, reason: dto.reason, totalAmount, createdById: userId },
      });

      for (const c of computed) {
        await tx.purchaseReturnLine.create({
          data: { purchaseReturnId: ret.id, purchaseOrderLineId: c.poLine.id, quantity: c.quantity, amount: c.amount },
        });
        await this.inventory.consume(tx, {
          locationId: po.locationId,
          ingredientId: c.poLine.ingredientId,
          quantity: c.quantity,
          reason: 'PURCHASE_RETURN',
          refId: ret.id,
        });
      }

      return tx.purchaseReturn.findUniqueOrThrow({ where: { id: ret.id }, include: { lines: true } });
    });
  }

  async findAll(userId: string, locationId?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.purchaseReturn.findMany({
      where: {
        purchaseOrder: locationId ? { locationId } : allowedIds ? { locationId: { in: allowedIds } } : {},
      },
      include: {
        lines: { include: { purchaseOrderLine: { include: { ingredient: true } } } },
        purchaseOrder: { include: { supplier: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
