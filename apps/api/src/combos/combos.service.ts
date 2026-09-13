import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ComboSlotInputDto, CreateComboDto } from './dto/create-combo.dto';
import { UpdateComboDto } from './dto/update-combo.dto';

const COMBO_INCLUDE = {
  slots: {
    orderBy: { sortOrder: 'asc' as const },
    include: { options: { include: { menuItem: { select: { id: true, name: true, price: true, category: true } } } } },
  },
};

@Injectable()
export class CombosService {
  constructor(private readonly prisma: PrismaService) {}

  private validateSlots(slots: ComboSlotInputDto[]) {
    for (const s of slots) {
      if (s.minSelect > s.maxSelect) throw new BadRequestException(`الحد الأدنى للاختيار في فئة "${s.label}" أكبر من الحد الأقصى`);
      if (s.maxSelect > s.options.length) throw new BadRequestException(`الحد الأقصى للاختيار في فئة "${s.label}" أكبر من عدد الخيارات المتاحة لها`);
    }
  }

  async create(dto: CreateComboDto) {
    this.validateSlots(dto.slots);
    const menuItemIds = [...new Set(dto.slots.flatMap((s) => s.options.map((o) => o.menuItemId)))];
    const existing = await this.prisma.menuItem.findMany({ where: { id: { in: menuItemIds } }, select: { id: true } });
    if (existing.length !== menuItemIds.length) throw new BadRequestException('أحد الأصناف المُختارة كخيار غير موجود');

    return this.prisma.comboMeal.create({
      data: {
        name: dto.name,
        basePrice: dto.basePrice,
        slots: {
          create: dto.slots.map((s, i) => ({
            label: s.label,
            minSelect: s.minSelect,
            maxSelect: s.maxSelect,
            sortOrder: i,
            options: { create: s.options.map((o) => ({ menuItemId: o.menuItemId, extraPrice: o.extraPrice })) },
          })),
        },
      },
      include: COMBO_INCLUDE,
    });
  }

  findAll() {
    return this.prisma.comboMeal.findMany({ include: COMBO_INCLUDE, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const combo = await this.prisma.comboMeal.findUnique({ where: { id }, include: COMBO_INCLUDE });
    if (!combo) throw new NotFoundException('الكمبو غير موجود');
    return combo;
  }

  async update(id: string, dto: UpdateComboDto) {
    await this.findOne(id);
    return this.prisma.comboMeal.update({ where: { id }, data: dto, include: COMBO_INCLUDE });
  }
}
