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

// Same "either the real PrismaService or a $transaction tx" shape as
// InventoryService.Db/ProdDb -- advanceLineInTx() below runs inside both
// advance()'s own single-line transaction and advanceCategory()'s
// multi-line one.
type KitchenDb = Pick<PrismaService, 'orderLine' | 'order'>;

// An order still counts as "the kitchen owes work on this" whether it's
// SENT_TO_KITCHEN (not yet paid) or PAID (a cashier can take payment
// before the kitchen finishes preparing it, e.g. a pay-first
// quick-service counter) -- either way, any line still QUEUED/PREPARING
// means the ticket must stay on the board until kitchen staff actually
// bumps it, never disappearing just because payment happened.
const ACTIVE_KITCHEN_ORDER_STATUSES = [OrderStatus.SENT_TO_KITCHEN, OrderStatus.PAID];

@Injectable()
export class KitchenService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  // The active queue is the orders the kitchen still owes work on: any
  // order in ACTIVE_KITCHEN_ORDER_STATUSES (SENT_TO_KITCHEN or PAID) with
  // at least one line still QUEUED/PREPARING -- once every line reaches
  // READY/SERVED it drops off this list on its own, whether or not it's
  // been paid. PLUS any order that got VOIDED (via OrdersService.void()
  // pre-payment, or ReturnsService.voidPaidOrder() after payment) while
  // the kitchen still had a line QUEUED/PREPARING on it -- neither void
  // path touches kitchenStatus, so that line is still sitting there
  // mid-prep with no idea the sale behind it was cancelled. Surfacing it
  // here (instead of it just silently vanishing) is the closest thing to
  // a "kitchen notification" this polling-based board has; it stays until
  // acknowledgeCancel() below dismisses it. A VOIDED order whose lines
  // were already all READY/SERVED never needed telling in the first place.
  async queue(userId: string, locationId: string) {
    await this.assertLocationInScope(userId, locationId);
    const orders = await this.prisma.order.findMany({
      where: {
        locationId,
        OR: [
          {
            status: { in: ACTIVE_KITCHEN_ORDER_STATUSES },
            lines: { some: { kitchenStatus: { in: [KitchenLineStatus.QUEUED, KitchenLineStatus.PREPARING] } } },
          },
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
      paid: order.status === OrderStatus.PAID,
      cancelled: order.status === OrderStatus.VOIDED,
      lines: order.lines.map((line) =>
        line.menuItem
          ? {
              lineId: line.id,
              menuItemName: line.menuItem.name,
              // Used by the "finish [category]" bulk-bump button -- groups
              // this line the same way the New Order menu grid groups it.
              category: line.menuItem.category,
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
              category: line.comboMeal!.category,
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

  // Shared by advance() (one line, its own transaction) and
  // advanceCategory() (many lines, one shared transaction) -- moves a
  // single line one step along NEXT_STATUS and, if that was the last line
  // on its order still needing work, flips the order itself to READY.
  // Returns null for a line that's already SERVED (nothing left to bump)
  // instead of throwing, since advanceCategory() just skips those rather
  // than failing the whole batch over one already-finished item.
  private async advanceLineInTx(tx: KitchenDb, lineId: string) {
    const line = await tx.orderLine.findUniqueOrThrow({ where: { id: lineId }, include: { order: true } });
    const next = NEXT_STATUS[line.kitchenStatus];
    if (!next) return null;

    const updatedLine = await tx.orderLine.update({
      where: { id: lineId },
      data: { kitchenStatus: next, readyAt: next === KitchenLineStatus.READY ? new Date() : undefined },
    });

    // Every line done (READY or already SERVED) and the order hasn't
    // moved past SENT_TO_KITCHEN on its own (e.g. via some other future
    // flow) -- flip it to READY so front-of-house knows to pick it up.
    // Deliberately skipped for a PAID order: READY and PAID share the same
    // Order.status field, and payment already happening first must not be
    // overwritten by the kitchen finishing later -- queue() drops a PAID
    // order the moment its last line is done regardless of this flip.
    const siblingLines = await tx.orderLine.findMany({ where: { orderId: line.orderId } });
    const allDone = siblingLines.every((l) => l.kitchenStatus === KitchenLineStatus.READY || l.kitchenStatus === KitchenLineStatus.SERVED);
    let orderStatus = line.order.status;
    if (allDone && line.order.status === OrderStatus.SENT_TO_KITCHEN) {
      await tx.order.update({ where: { id: line.orderId }, data: { status: OrderStatus.READY } });
      orderStatus = OrderStatus.READY;
    }

    return { line: updatedLine, orderStatus };
  }

  async advance(lineId: string, userId: string) {
    const line = await this.prisma.orderLine.findUnique({ where: { id: lineId }, include: { order: true } });
    if (!line) throw new NotFoundException('عنصر الطلب غير موجود');
    await this.assertLocationInScope(userId, line.order.locationId);
    if (line.order.status === OrderStatus.VOIDED) {
      throw new BadRequestException('لا يمكن تحديث تحضير عنصر من طلب مُلغى');
    }
    if (!NEXT_STATUS[line.kitchenStatus]) {
      throw new BadRequestException('العنصر جاهز وسُلِّم بالفعل -- لا يوجد انتقال إضافي');
    }

    return this.prisma.$transaction((tx) => this.advanceLineInTx(tx, lineId));
  }

  // Bumps every not-yet-SERVED line of the given menu category (or combo
  // category) across the location's whole active kitchen queue one step
  // forward, in a single call -- e.g. "قسم المشروبات" all at once instead
  // of clicking "تقدّم" on each drink individually. Each line still only
  // moves ONE step (same as the per-line button), so a mixed batch (some
  // QUEUED, some already PREPARING) ends up at mixed next-statuses, not
  // all forced to the same one -- pressing the button again advances
  // whatever's left. Lines on a VOIDED order are excluded, same as
  // advance() itself refusing them one at a time.
  async advanceCategory(userId: string, locationId: string, category: string) {
    await this.assertLocationInScope(userId, locationId);

    return this.prisma.$transaction(async (tx) => {
      const lines = await tx.orderLine.findMany({
        where: {
          order: { locationId, status: { in: ACTIVE_KITCHEN_ORDER_STATUSES } },
          kitchenStatus: { not: KitchenLineStatus.SERVED },
          OR: [{ menuItem: { category } }, { comboMeal: { category } }],
        },
        select: { id: true },
      });

      let advancedCount = 0;
      for (const line of lines) {
        const result = await this.advanceLineInTx(tx, line.id);
        if (result) advancedCount += 1;
      }
      return { advancedCount };
    });
  }
}
