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

  // The active queue is exactly the orders the kitchen still owes work on
  // -- SENT_TO_KITCHEN. Once every line on an order reaches READY/SERVED,
  // advance() flips the order itself to READY (see below) and it drops off
  // this list on its own; no separate filtering needed here.
  async queue(userId: string, locationId: string) {
    await this.assertLocationInScope(userId, locationId);
    const orders = await this.prisma.order.findMany({
      where: { locationId, status: OrderStatus.SENT_TO_KITCHEN },
      orderBy: { createdAt: 'asc' },
      include: {
        table: true,
        lines: { include: { menuItem: true } },
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
      lines: order.lines.map((line) => ({
        lineId: line.id,
        menuItemName: line.menuItem.name,
        quantity: line.quantity,
        kitchenStatus: line.kitchenStatus,
      })),
    }));
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
      const updatedLine = await tx.orderLine.update({ where: { id: lineId }, data: { kitchenStatus: next } });

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
