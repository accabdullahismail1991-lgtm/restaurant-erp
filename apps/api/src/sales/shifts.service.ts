import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const shift = await this.prisma.shift.findUnique({ where: { id } });
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
      orderBy: { openedAt: 'desc' },
    });
  }

  // Cash reconciliation (القرار #12): expected cash = opening float + every
  // CASH payment on a PAID order tied to this shift. Variance = what the
  // cashier actually counted minus that. Only cash is reconciled here --
  // card/wallet settle through their own terminal, not the till.
  async close(id: string, dto: CloseShiftDto, userId: string) {
    const shift = await this.findOne(id, userId);
    if (shift.closedAt) throw new BadRequestException('الوردية مغلقة بالفعل');

    const cashPayments = await this.prisma.payment.aggregate({
      where: { method: 'CASH', order: { shiftId: id, status: OrderStatus.PAID } },
      _sum: { amount: true },
    });
    const expectedCash = Number(shift.openingFloat) + Number(cashPayments._sum.amount ?? 0);
    const variance = dto.closingCounted - expectedCash;

    return this.prisma.shift.update({
      where: { id },
      data: { closingCounted: dto.closingCounted, expectedCash, variance, closedAt: new Date() },
    });
  }
}
