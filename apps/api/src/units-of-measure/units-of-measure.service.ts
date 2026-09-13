import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

@Injectable()
export class UnitsOfMeasureService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.unitOfMeasure.findMany({ orderBy: { code: 'asc' } });
  }

  async create(dto: CreateUnitDto) {
    const existing = await this.prisma.unitOfMeasure.findUnique({ where: { code: dto.code } });
    if (existing) throw new BadRequestException('يوجد وحدة قياس بهذا الكود بالفعل');
    return this.prisma.unitOfMeasure.create({ data: dto });
  }

  async update(id: string, dto: UpdateUnitDto) {
    const unit = await this.prisma.unitOfMeasure.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('وحدة القياس غير موجودة');
    return this.prisma.unitOfMeasure.update({ where: { id }, data: dto });
  }
}
