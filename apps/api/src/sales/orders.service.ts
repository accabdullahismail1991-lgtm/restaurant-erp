import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZatcaService } from '../zatca/zatca.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { PayOrderDto } from './dto/pay-order.dto';

// KSA standard VAT rate (docs/DECISIONS.md #3: ZATCA compliance).
const VAT_RATE = 0.15;
const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly zatca: ZatcaService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  // Creating an order IS the confirmation event in this MVP -- there is no
  // separate "add items then send to kitchen" step yet (that's a natural
  // future enhancement once KDS/Phase 10 needs it), so inventory is
  // deducted for every line right here, atomically with the order itself:
  // docs/ARCHITECTURE.md's "Sales <-> Items <-> Inventory" integration
  // point requires this to be all-or-nothing (a single DB transaction),
  // never "order saved but stock deduction failed".
  async create(dto: CreateOrderDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);

    const shift = await this.prisma.shift.findUnique({ where: { id: dto.shiftId } });
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.locationId !== dto.locationId) throw new BadRequestException('الوردية لا تخص هذا الموقع');
    if (shift.closedAt) throw new BadRequestException('لا يمكن إنشاء طلب على وردية مغلقة');

    const menuItemIds = [...new Set(dto.lines.map((l) => l.menuItemId))];
    const menuItems = await this.prisma.menuItem.findMany({ where: { id: { in: menuItemIds } } });
    if (menuItems.length !== menuItemIds.length) {
      throw new BadRequestException('أحد أصناف المنيو المطلوبة غير موجود');
    }
    const inactive = menuItems.find((m) => !m.isActive);
    if (inactive) throw new BadRequestException(`الصنف "${inactive.name}" غير متاح حاليًا`);
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    const subtotal = round2(dto.lines.reduce((sum, l) => sum + Number(byId.get(l.menuItemId)!.price) * l.quantity, 0));
    const discountTotal = round2(dto.discountTotal ?? 0);
    if (discountTotal > subtotal) throw new BadRequestException('قيمة الخصم أكبر من إجمالي الفاتورة');
    const vatTotal = round2((subtotal - discountTotal) * VAT_RATE);
    const grandTotal = round2(subtotal - discountTotal + vatTotal);

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          locationId: dto.locationId,
          tableId: dto.tableId,
          customerId: dto.customerId,
          shiftId: dto.shiftId,
          channel: dto.channel,
          status: OrderStatus.SENT_TO_KITCHEN,
          servedById: userId,
          subtotal,
          discountTotal,
          vatTotal,
          grandTotal,
        },
      });

      for (const line of dto.lines) {
        const menuItem = byId.get(line.menuItemId)!;
        await tx.orderLine.create({
          data: { orderId: order.id, menuItemId: menuItem.id, quantity: line.quantity, unitPrice: menuItem.price },
        });

        // Non-recursive: a menu item's recipe only lists its DIRECT
        // components. If one of those is itself SEMI_FINISHED, we deduct
        // from ITS OWN balance (produced earlier by a Production Order,
        // Phase 6) -- not its sub-ingredients, per
        // docs/ARCHITECTURE.md's "Sales <-> Items <-> Inventory" section.
        const recipeLines = await tx.recipeLine.findMany({ where: { menuItemId: menuItem.id } });
        for (const recipeLine of recipeLines) {
          await this.inventory.consume(tx, {
            locationId: dto.locationId,
            ingredientId: recipeLine.ingredientId,
            quantity: Number(recipeLine.quantity) * line.quantity,
            reason: 'SALE',
            refId: order.id,
          });
        }
      }

      return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } });
    });
  }

  async findOne(id: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { lines: true, payments: true } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    await this.assertLocationInScope(userId, order.locationId);
    return order;
  }

  async findAll(userId: string, locationId?: string, status?: OrderStatus) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.order.findMany({
      where: {
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
        status,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async pay(id: string, dto: PayOrderDto, userId: string) {
    const order = await this.findOne(id, userId);
    if (order.status === OrderStatus.PAID) throw new BadRequestException('الطلب مدفوع بالفعل');
    if (order.status === OrderStatus.VOIDED) throw new BadRequestException('لا يمكن دفع طلب مُلغى');

    const totalPaid = round2(dto.payments.reduce((sum, p) => sum + p.amount, 0));
    if (Math.abs(totalPaid - Number(order.grandTotal)) > 0.01) {
      throw new BadRequestException(`المبلغ المدفوع (${totalPaid}) لا يساوي إجمالي الفاتورة (${order.grandTotal})`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.payment.createMany({
        data: dto.payments.map((p) => ({ orderId: id, method: p.method, mode: p.mode, amount: p.amount, terminalRef: p.terminalRef })),
      });
      await tx.order.update({ where: { id }, data: { status: OrderStatus.PAID, paidAt: new Date() } });
      // Same transaction as the sale itself (docs/DECISIONS.md #3: generated
      // and signed LOCALLY at sale time) -- no-ops if the location has no
      // vatNumber configured, since a missing invoicing setting must never
      // block an actual cash sale.
      await this.zatca.generateForOrder(tx, id);
      return tx.order.findUniqueOrThrow({ where: { id }, include: { lines: true, payments: true } });
    });
  }

  async submitZatca(id: string, userId: string) {
    await this.findOne(id, userId); // scope check + 404 if missing
    return this.zatca.submitToZatca(id);
  }

  // Only reachable before payment -- refunding an already-PAID order is a
  // separate concern (a return/refund flow) out of scope for this phase.
  async void(id: string, userId: string) {
    const order = await this.findOne(id, userId);
    if (order.status === OrderStatus.PAID) throw new BadRequestException('لا يمكن إلغاء طلب مدفوع بالفعل -- يحتاج مسار استرجاع منفصل');
    if (order.status === OrderStatus.VOIDED) throw new BadRequestException('الطلب ملغى بالفعل');

    return this.prisma.$transaction(async (tx) => {
      await this.inventory.reverseConsumption(tx, { refId: id, matchReason: 'SALE', restockReason: 'SALE_VOID_RESTOCK' });
      return tx.order.update({ where: { id }, data: { status: OrderStatus.VOIDED }, include: { lines: true } });
    });
  }
}
