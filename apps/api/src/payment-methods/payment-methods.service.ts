import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePaymentMethodDto) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException('يوجد بالفعل طريقة دفع بنفس الكود');
    return this.prisma.paymentMethod.create({ data: dto });
  }

  findAll(activeOnly?: boolean) {
    return this.prisma.paymentMethod.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(id: string, dto: UpdatePaymentMethodDto) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('طريقة الدفع غير موجودة');
    return this.prisma.paymentMethod.update({ where: { id }, data: dto });
  }

  // Which method CODES currently count as "cash in the till" -- used by
  // ShiftsService.close() instead of a hardcoded 'CASH' string, so
  // renaming/adding a cash-like method (e.g. a second till currency)
  // doesn't require a code change anywhere else.
  async cashMethodCodes(): Promise<string[]> {
    const methods = await this.prisma.paymentMethod.findMany({ where: { isCash: true }, select: { code: true } });
    return methods.map((m) => m.code);
  }
}
