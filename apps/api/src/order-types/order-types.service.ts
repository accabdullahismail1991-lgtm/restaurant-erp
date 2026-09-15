import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderTypeDto } from './dto/create-order-type.dto';
import { UpdateOrderTypeDto } from './dto/update-order-type.dto';

@Injectable()
export class OrderTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrderTypeDto) {
    const existing = await this.prisma.orderType.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException('يوجد بالفعل نوع طلب بنفس الكود');
    return this.prisma.orderType.create({ data: dto });
  }

  findAll(activeOnly?: boolean) {
    return this.prisma.orderType.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(id: string, dto: UpdateOrderTypeDto) {
    const existing = await this.prisma.orderType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('نوع الطلب غير موجود');
    return this.prisma.orderType.update({ where: { id }, data: dto });
  }

  // Used by OrdersService.create() and PromotionsService (create/update)
  // instead of the old `@IsIn(Object.values(OrderChannel))` compile-time
  // enum check -- an order/promotion's channel code must reference a real,
  // currently-active OrderType row. Throws the same message shape both
  // callers already surfaced for an unknown channel, so this is a
  // behavior-preserving refactor for the 5 pre-existing codes.
  async assertActiveCode(code: string, label: string) {
    const type = await this.prisma.orderType.findUnique({ where: { code } });
    if (!type || !type.isActive) throw new BadRequestException(`${label} غير موجود أو غير مفعّل`);
  }
}
