import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

// 1 point earned per 10 currency units of grandTotal (floor), 1 point
// redeemable for 0.10 currency units -- simple, documented rates rather
// than a per-branch/franchise configurable scheme, which is a reasonable
// next step but out of scope for this phase.
export const EARN_CURRENCY_PER_POINT = 10;
export const REDEEM_POINT_VALUE = 0.1;

type Db = Pick<PrismaService, 'customer' | 'loyaltyTransaction'>;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { phone: dto.phone } });
    if (existing) throw new ConflictException('رقم الجوال مستخدم بالفعل لعميل آخر');
    return this.prisma.customer.create({ data: { phone: dto.phone, name: dto.name } });
  }

  findAll(phone?: string) {
    return this.prisma.customer.findMany({
      where: phone ? { phone: { contains: phone } } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('العميل غير موجود');
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findOne(id);
    if (dto.phone) {
      const existing = await this.prisma.customer.findUnique({ where: { phone: dto.phone } });
      if (existing && existing.id !== id) throw new ConflictException('رقم الجوال مستخدم بالفعل لعميل آخر');
    }
    return this.prisma.customer.update({ where: { id }, data: dto });
  }

  async ledger(id: string) {
    await this.findOne(id);
    return this.prisma.loyaltyTransaction.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } });
  }

  // Called from inside OrdersService.pay()'s own transaction -- same
  // "ledger row + cached aggregate updated together" pattern as
  // InventoryService.consume/receive use for StockMovement/InventoryBalance.
  async awardPoints(tx: Db, customerId: string, points: number, reason: string, orderId?: string) {
    if (points <= 0) return; // a sub-threshold sale earns nothing; never write a zero/negative "earn" row
    await tx.loyaltyTransaction.create({ data: { customerId, points, reason, orderId } });
    await tx.customer.update({ where: { id: customerId }, data: { points: { increment: points } } });
  }

  async redeemPoints(customerId: string, points: number) {
    const customer = await this.findOne(customerId);
    if (points > customer.points) {
      throw new BadRequestException(`رصيد العميل ${customer.points} نقطة فقط -- لا يمكن استبدال ${points}`);
    }
    const cashValue = Math.round(points * REDEEM_POINT_VALUE * 100) / 100;
    const [, updated] = await this.prisma.$transaction([
      this.prisma.loyaltyTransaction.create({ data: { customerId, points: -points, reason: 'REDEEM' } }),
      this.prisma.customer.update({ where: { id: customerId }, data: { points: { decrement: points } } }),
    ]);
    return { customer: updated, pointsRedeemed: points, cashValue };
  }
}
