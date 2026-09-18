import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { KitchenLineStatus, OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';

// The order in which a kitchen ticket line moves forward -- a real KDS
// screen has one "bump" action per line, not an arbitrary status picker,
// so advance() always moves exactly one step along this sequence.
const NEXT_STATUS: Record<KitchenLineStatus, KitchenLineStatus | null> = {
  QUEUED: KitchenLineStatus.PREPARING,
  PREPARING: KitchenLineStatus.READY,
  READY: KitchenLineStatus.SERVED,
  SERVED: null,
};

@Injectable()
export class KitchenService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  // The active queue is the orders the kitchen still owes work on
  // (SENT_TO_KITCHEN -- once every line reaches READY/SERVED, advance()
  // flips the order itself to READY and it drops off this list on its own)
  // PLUS any order that got VOIDED (via OrdersService.void() pre-payment,
  // or ReturnsService.voidPaidOrder() after payment) while the kitchen
  // still had a line QUEUED/PREPARING on it -- neither void path touches
  // kitchenStatus, so that line is still sitting there mid-prep with no
  // idea the sale behind it was cancelled. Surfacing it here (instead of
  // it just silently vanishing) is the closest thing to a "kitchen
  // notification" this polling-based board has; it stays until
  // acknowledgeCancel() below dismisses it. A VOIDED order whose lines
  // were already all READY/SERVED never needed telling in the first place.
  async queue(userId: string, locationId: string) {
    await this.assertLocationInScope(userId, locationId);
    const orders = await this.prisma.order.findMany({
      where: {
        locationId,
        OR: [
          { status: OrderStatus.SENT_TO_KITCHEN },
          {
            status: OrderStatus.VOIDED,
            kitchenCancelAckAt: null,
            lines: { some: { kitchenStatus: { in: [KitchenLineStatus.QUEUED, KitchenLineStatus.PREPARING] } } },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        table: true,
        shift: { select: { shiftNumber: true } },
        lines: {
          include: {
            menuItem: true,
            comboMeal: true,
            comboSelections: { include: { menuItem: true, comboSlot: true } },
          },
        },
      },
    });
    return orders.map((order) => ({
      orderId: order.id,
      channel: order.channel,
      tableLabel: order.table?.label ?? null,
      createdAt: order.createdAt,
      // Same human-readable numbers the cashier invoice shows -- lets a
      // printed kitchen ticket say "order #3 this shift" instead of a raw
      // internal id, without adding yet another counter.
      shiftSequence: order.shiftSequence,
      dailySequence: order.dailySequence,
      shiftNumber: order.shift?.shiftNumber ?? null,
      cancelled: order.status === OrderStatus.VOIDED,
      lines: order.lines.map((line) =>
        line.menuItem
          ? {
              lineId: line.id,
              menuItemName: line.menuItem.name,
              quantity: line.quantity,
              kitchenStatus: line.kitchenStatus,
              note: line.note,
            }
          : {
              lineId: line.id,
              // A combo line has no single item name -- the kitchen ticket
              // needs the full composition (e.g. "وجبة كمبو: برجر × 1، بطاطس × 2").
              menuItemName: `${line.comboMeal!.name}: ${line.comboSelections
                .map((s) => `${s.menuItem.name} × ${s.quantity}`)
                .join('، ')}`,
              quantity: line.quantity,
              kitchenStatus: line.kitchenStatus,
              note: line.note,
            },
      ),
    }));
  }

  // Dismisses a cancelled ticket from the KDS board -- the only action
  // available on a VOIDED order's ticket (its lines can't be "advance"d
  // any further, there's nothing left to bump).
  async acknowledgeCancel(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    if (order.status !== OrderStatus.VOIDED) {
      throw new BadRequestException('هذا الطلب ليس ملغى');
    }
    return this.prisma.order.update({ where: { id: orderId }, data: { kitchenCancelAckAt: new Date() } });
  }

  async advance(lineId: string, userId: string) {
    const line = await this.prisma.orderLine.findUnique({ where: { id: lineId }, include: { order: true } });
    if (!line) throw new NotFoundException('عنصر الطلب غير موجود');
    await this.assertLocationInScope(userId, line.order.locationId);
    if (line.order.status === OrderStatus.VOIDED) {
      throw new BadRequestException('لا يمكن تحديث تحضير عنصر من طلب مُلغى');
    }

    const next = NEXT_STATUS[line.kitchenStatus];
    if (!next) throw new BadRequestException('العنصر جاهز وسُلِّم بالفعل -- لا يوجد انتقال إضافي');

    return this.prisma.$transaction(async (tx) => {
      const updatedLine = await tx.orderLine.update({
        where: { id: lineId },
        data: { kitchenStatus: next, readyAt: next === KitchenLineStatus.READY ? new Date() : undefined },
      });

      // Every line done (READY or already SERVED) and the order hasn't
      // moved past SENT_TO_KITCHEN on its own (e.g. via some other future
      // flow) -- flip it to READY so front-of-house knows to pick it up.
      const siblingLines = await tx.orderLine.findMany({ where: { orderId: line.orderId } });
      const allDone = siblingLines.every((l) => l.kitchenStatus === KitchenLineStatus.READY || l.kitchenStatus === KitchenLineStatus.SERVED);
      let orderStatus = line.order.status;
      if (allDone && line.order.status === OrderStatus.SENT_TO_KITCHEN) {
        await tx.order.update({ where: { id: line.orderId }, data: { status: OrderStatus.READY } });
        orderStatus = OrderStatus.READY;
      }

      return { line: updatedLine, orderStatus };
    });
  }
}
