import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';

// KSA standard VAT rate -- same constant re-declared per-file as
// OrdersService/ZatcaService already do (docs/DECISIONS.md #3).
const VAT_RATE = 0.15;
const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class ReturnsService {
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

  // What's left returnable per line of a given order -- the admin panel's
  // return form is built entirely from this (quantity sold minus whatever
  // was already returned across any PRIOR OrderReturn for the same line).
  async returnableLines(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lines: { include: { menuItem: true } } } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    if (order.status !== 'PAID') throw new BadRequestException('لا يمكن عمل مرتجع إلا لطلب مدفوع بالكامل');

    const priorLines = await this.prisma.orderReturnLine.findMany({ where: { orderLineId: { in: order.lines.map((l) => l.id) } } });
    const returnedByLine = new Map<string, number>();
    for (const p of priorLines) returnedByLine.set(p.orderLineId, (returnedByLine.get(p.orderLineId) || 0) + p.quantity);

    return order.lines.map((l) => ({
      orderLineId: l.id,
      menuItemId: l.menuItemId,
      menuItemName: l.menuItem.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      alreadyReturned: returnedByLine.get(l.id) || 0,
      remaining: l.quantity - (returnedByLine.get(l.id) || 0),
    }));
  }

  // Restocks the exact recipe quantities the returned menu-item quantity
  // would have consumed (same math OrdersService.create() used to consume
  // them), at the ingredient's CURRENT weighted-average cost -- a
  // deliberate simplification, same one stocktake variance valuation
  // already uses, since a return doesn't cleanly identify which original
  // batch(es) each returned unit came from. Refund is unitPrice x quantity
  // grossed up by the flat VAT rate (this MVP doesn't allocate the
  // original order's discount proportionally across lines).
  //
  // Loyalty points earned on the original order are NOT reversed here --
  // a documented scope boundary rather than a half-built proportional
  // reversal, same "don't fake what isn't built" stance as ZATCA submit.
  async create(dto: CreateReturnDto, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: dto.orderId }, include: { lines: true } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    if (order.status !== 'PAID') throw new BadRequestException('لا يمكن عمل مرتجع إلا لطلب مدفوع بالكامل');

    const orderLineIds = dto.lines.map((l) => l.orderLineId);
    const orderLines = order.lines.filter((l) => orderLineIds.includes(l.id));
    if (orderLines.length !== new Set(orderLineIds).size) {
      throw new BadRequestException('أحد سطور الطلب غير موجود في هذا الطلب');
    }

    const priorLines = await this.prisma.orderReturnLine.findMany({ where: { orderLineId: { in: orderLineIds } } });
    const returnedByLine = new Map<string, number>();
    for (const p of priorLines) returnedByLine.set(p.orderLineId, (returnedByLine.get(p.orderLineId) || 0) + p.quantity);

    let refundTotal = 0;
    const computed = dto.lines.map((l) => {
      const orderLine = orderLines.find((ol) => ol.id === l.orderLineId)!;
      const already = returnedByLine.get(l.orderLineId) || 0;
      if (already + l.quantity > orderLine.quantity) {
        throw new BadRequestException(`الكمية المطلوب إرجاعها أكبر من المتبقي القابل للإرجاع لهذا الصنف`);
      }
      const refundAmount = round2(Number(orderLine.unitPrice) * l.quantity * (1 + VAT_RATE));
      refundTotal += refundAmount;
      return { orderLine, quantity: l.quantity, refundAmount };
    });
    refundTotal = round2(refundTotal);

    return this.prisma.$transaction(async (tx) => {
      const ret = await tx.orderReturn.create({
        data: { orderId: order.id, reason: dto.reason, refundTotal, createdById: userId },
      });

      for (const c of computed) {
        await tx.orderReturnLine.create({
          data: { returnId: ret.id, orderLineId: c.orderLine.id, quantity: c.quantity, refundAmount: c.refundAmount },
        });

        const recipeLines = await tx.recipeLine.findMany({ where: { menuItemId: c.orderLine.menuItemId } });
        for (const recipeLine of recipeLines) {
          const unitCost = await this.inventory.averageUnitCost(order.locationId, recipeLine.ingredientId);
          await this.inventory.receive(tx, {
            locationId: order.locationId,
            ingredientId: recipeLine.ingredientId,
            quantity: Number(recipeLine.quantity) * c.quantity,
            unitCost: Number(unitCost),
            sourceType: 'RETURN',
            sourceId: ret.id,
            reason: 'SALE_RETURN',
          });
        }
      }

      return tx.orderReturn.findUniqueOrThrow({ where: { id: ret.id }, include: { lines: true } });
    });
  }

  async findAll(userId: string, locationId?: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.orderReturn.findMany({
      where: {
        order: locationId ? { locationId } : allowedIds ? { locationId: { in: allowedIds } } : {},
      },
      include: { lines: { include: { orderLine: { include: { menuItem: true } } } }, order: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
