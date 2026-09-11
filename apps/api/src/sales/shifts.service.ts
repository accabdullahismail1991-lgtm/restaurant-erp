import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  async open(dto: OpenShiftDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);
    // One open shift per location at a time -- cash reconciliation
    // (docs/DECISIONS.md #12) only makes sense against a single till.
    const existingOpen = await this.prisma.shift.findFirst({ where: { locationId: dto.locationId, closedAt: null } });
    if (existingOpen) {
      throw new ConflictException('يوجد وردية مفتوحة بالفعل لهذا الموقع -- يجب إغلاقها أولًا');
    }
    return this.prisma.shift.create({
      data: { locationId: dto.locationId, openedById: userId, openingFloat: dto.openingFloat },
    });
  }

  async findOne(id: string, userId: string) {
    const shift = await this.prisma.shift.findUnique({
      where: { id },
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
    });
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    await this.assertLocationInScope(userId, shift.locationId);
    return shift;
  }

  async findAll(userId: string, locationId?: string, openOnly?: boolean) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.shift.findMany({
      where: {
        locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined,
        closedAt: openOnly ? null : undefined,
      },
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
      orderBy: { openedAt: 'desc' },
    });
  }

  // Cash reconciliation (القرار #12): expected cash = opening float + every
  // payment made in a method flagged isCash (PaymentMethodsService), on a
  // PAID order tied to this shift. Variance = what the cashier actually
  // counted minus that. Only cash-flagged methods are reconciled here --
  // card/wallet/etc settle through their own terminal, not the till.
  async close(id: string, dto: CloseShiftDto, userId: string) {
    const shift = await this.findOne(id, userId);
    if (shift.closedAt) throw new BadRequestException('الوردية مغلقة بالفعل');

    const cashMethodCodes = await this.paymentMethods.cashMethodCodes();
    const cashPayments = await this.prisma.payment.aggregate({
      where: { method: { in: cashMethodCodes }, order: { shiftId: id, status: OrderStatus.PAID } },
      _sum: { amount: true },
    });
    const expectedCash = Number(shift.openingFloat) + Number(cashPayments._sum.amount ?? 0);
    const variance = dto.closingCounted - expectedCash;

    return this.prisma.shift.update({
      where: { id },
      data: { closingCounted: dto.closingCounted, expectedCash, variance, closedAt: new Date(), closedById: userId },
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } } },
    });
  }
}
