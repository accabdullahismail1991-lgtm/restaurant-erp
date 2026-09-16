import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { userHasPermission } from '../common/permission.util';
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
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: { include: { menuItem: true, comboMeal: true } } },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    if (order.status !== 'PAID') throw new BadRequestException('لا يمكن عمل مرتجع إلا لطلب مدفوع بالكامل');

    // Combo-meal lines are excluded from the returnable list entirely (v1
    // scope boundary, see create() below) -- there's no per-item recipe to
    // restock against a single OrderLine that spans several chosen items.
    const returnableOrderLines = order.lines.filter((l) => l.menuItemId);
    const priorLines = await this.prisma.orderReturnLine.findMany({ where: { orderLineId: { in: returnableOrderLines.map((l) => l.id) } } });
    const returnedByLine = new Map<string, number>();
    for (const p of priorLines) returnedByLine.set(p.orderLineId, (returnedByLine.get(p.orderLineId) || 0) + p.quantity);

    return returnableOrderLines.map((l) => ({
      orderLineId: l.id,
      menuItemId: l.menuItemId,
      menuItemName: l.menuItem!.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      alreadyReturned: returnedByLine.get(l.id) || 0,
      remaining: l.quantity - (returnedByLine.get(l.id) || 0),
      // Lets the admin panel warn (or grey out) a line the kitchen hasn't
      // finished yet -- create() below enforces the same rule server-side,
      // this is only so the UI doesn't have to guess before submitting.
      kitchenStatus: l.kitchenStatus,
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
    // Combo-meal lines can't be returned in v1 -- a single OrderLine spans
    // several chosen items with no per-item recipe to restock against, and
    // a partial "return just one component" flow isn't built. Reject
    // cleanly rather than silently mismatching unrelated RecipeLine rows
    // (RecipeLine.menuItemId is also nullable for semi-finished items).
    if (orderLines.some((l) => l.comboMealId)) {
      throw new BadRequestException('لا يمكن حاليًا إرجاع عنصر وجبة كمبو -- يُرجى التواصل مع الإدارة');
    }
    // A line still QUEUED/PREPARING never left the kitchen -- nothing was
    // actually consumed/served yet, so "returning" it here would restock
    // ingredients that were never taken out in the first place and
    // silently double the inventory. READY/SERVED are the only states the
    // kitchen has genuinely finished (or handed over) the item in.
    //
    // A holder of pos.override_kitchen_block can push through anyway (e.g.
    // a manager clearing a stuck order) -- dto.overrideKitchenBlock is just
    // the caller's stated intent, the permission check below is what
    // actually decides it, so sending the flag without the permission still
    // 400s exactly like not sending it at all.
    const notReady = orderLines.filter((l) => l.kitchenStatus !== 'READY' && l.kitchenStatus !== 'SERVED');
    if (notReady.length) {
      const overriding = dto.overrideKitchenBlock && (await userHasPermission(this.prisma, userId, 'pos.override_kitchen_block'));
      if (!overriding) {
        throw new BadRequestException('لا يمكن إرجاع صنف لم يخرج من المطبخ بعد -- بعض السطور المطلوبة ما زالت قيد التحضير في المطبخ');
      }
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
      }
      await this.restockComputedLines(tx, order.locationId, ret.id, computed);

      await tx.orderActivityLog.create({
        data: { orderId: order.id, action: 'RETURNED', note: dto.reason, createdById: userId },
      });
      if (notReady.length) {
        await tx.orderActivityLog.create({
          data: {
            orderId: order.id,
            action: 'RETURN_KITCHEN_BLOCK_OVERRIDDEN',
            note: `تم تجاوز حظر المطبخ لعدد ${notReady.length} من سطور هذا المرتجع`,
            createdById: userId,
          },
        });
      }

      return tx.orderReturn.findUniqueOrThrow({ where: { id: ret.id }, include: { lines: true } });
    });
  }

  // Restocks the recipe of every computed return line into `tx`, tagged to
  // `returnId` -- the inventory-side half of both create() above and
  // voidPaidOrder() below, pulled out so neither has to duplicate the
  // per-line recipe lookup + weighted-average costing.
  private async restockComputedLines(
    tx: Prisma.TransactionClient,
    locationId: string,
    returnId: string,
    computed: Array<{ orderLine: { menuItemId: string | null }; quantity: number }>,
  ) {
    for (const c of computed) {
      const recipeLines = await tx.recipeLine.findMany({ where: { menuItemId: c.orderLine.menuItemId! } });
      for (const recipeLine of recipeLines) {
        const unitCost = await this.inventory.averageUnitCost(locationId, recipeLine.ingredientId);
        await this.inventory.receive(tx, {
          locationId,
          ingredientId: recipeLine.ingredientId,
          quantity: Number(recipeLine.quantity) * c.quantity,
          unitCost: Number(unitCost),
          sourceType: 'RETURN',
          sourceId: returnId,
          reason: 'SALE_RETURN',
        });
      }
    }
  }

  // Cancels a PAID order in full -- distinct from OrdersService.void() (only
  // reachable BEFORE payment): this refunds/restocks every remaining
  // returnable line exactly like create() above, then flips the order to
  // VOIDED so it reads as cancelled rather than merely "fully returned".
  // Deliberately does NOT enforce the kitchen-readiness block create() does
  // -- voiding the whole order means none of it should have happened, so a
  // line still QUEUED restocks the same as one that reached READY. Gated
  // entirely by pos.void_paid_order at the controller (a stricter,
  // manager-only permission from pos.return_order), never by the per-line
  // kitchen-block override.
  async voidPaidOrder(orderId: string, userId: string, reason?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    if (order.status !== 'PAID') throw new BadRequestException('لا يمكن إلغاء إلا طلبًا مدفوعًا بالكامل -- الطلبات غير المدفوعة تُلغى عبر إلغاء الطلب العادي');

    // A combo line has no per-item recipe to restock (same v1 boundary as
    // create()) -- voiding the WHOLE order can't leave one line un-restocked
    // silently, so an order carrying any combo line is rejected entirely
    // rather than voiding everything else around it.
    if (order.lines.some((l) => l.comboMealId)) {
      throw new BadRequestException('لا يمكن حاليًا إلغاء فاتورة تحتوي على وجبة كمبو -- يُرجى التواصل مع الإدارة');
    }

    const menuItemLines = order.lines.filter((l) => l.menuItemId);
    const priorLines = await this.prisma.orderReturnLine.findMany({ where: { orderLineId: { in: menuItemLines.map((l) => l.id) } } });
    const returnedByLine = new Map<string, number>();
    for (const p of priorLines) returnedByLine.set(p.orderLineId, (returnedByLine.get(p.orderLineId) || 0) + p.quantity);

    let refundTotal = 0;
    const computed = menuItemLines
      .map((orderLine) => {
        const remaining = orderLine.quantity - (returnedByLine.get(orderLine.id) || 0);
        const refundAmount = round2(Number(orderLine.unitPrice) * remaining * (1 + VAT_RATE));
        return { orderLine, quantity: remaining, refundAmount };
      })
      .filter((c) => c.quantity > 0);
    refundTotal = round2(computed.reduce((s, c) => s + c.refundAmount, 0));

    return this.prisma.$transaction(async (tx) => {
      if (computed.length) {
        const ret = await tx.orderReturn.create({
          data: { orderId: order.id, reason: reason ?? 'إلغاء الفاتورة بالكامل', refundTotal, createdById: userId },
        });
        for (const c of computed) {
          await tx.orderReturnLine.create({
            data: { returnId: ret.id, orderLineId: c.orderLine.id, quantity: c.quantity, refundAmount: c.refundAmount },
          });
        }
        await this.restockComputedLines(tx, order.locationId, ret.id, computed);
      }

      await tx.orderActivityLog.create({
        data: { orderId: order.id, action: 'VOIDED', note: reason ?? 'إلغاء فاتورة مدفوعة بالكامل', createdById: userId },
      });

      return tx.order.update({ where: { id: order.id }, data: { status: 'VOIDED' }, include: { lines: true } });
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
