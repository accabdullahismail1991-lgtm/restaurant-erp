import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

@Injectable()
export class UnitsOfMeasureService {
  constructor(private readonly prisma: PrismaService) {}

  // `hasMovement` mirrors IngredientsService.findAll's own flag -- true
  // when ANY ingredient using this unit's code has recorded inventory
  // movement, which is exactly what update() above blocks a code rename on.
  // Surfaced here so the admin panel can grey out/hint the rename control
  // without a separate round trip per row.
  async findAll() {
    const units = await this.prisma.unitOfMeasure.findMany({ orderBy: { code: 'asc' } });
    const ingredients = await this.prisma.ingredient.findMany({ select: { id: true, unit: true } });
    const idsByCode = new Map<string, string[]>();
    for (const i of ingredients) idsByCode.set(i.unit, [...(idsByCode.get(i.unit) ?? []), i.id]);
    const batchCounts = await this.prisma.inventoryBatch.groupBy({ by: ['ingredientId'], _count: { ingredientId: true } });
    const withMovement = new Set(batchCounts.map((b) => b.ingredientId));
    return units.map((u) => ({ ...u, hasMovement: (idsByCode.get(u.code) ?? []).some((id) => withMovement.has(id)) }));
  }

  async create(dto: CreateUnitDto) {
    const existing = await this.prisma.unitOfMeasure.findUnique({ where: { code: dto.code } });
    if (existing) throw new BadRequestException('يوجد وحدة قياس بهذا الكود بالفعل');
    return this.prisma.unitOfMeasure.create({ data: dto });
  }

  async update(id: string, dto: UpdateUnitDto) {
    const unit = await this.prisma.unitOfMeasure.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('وحدة القياس غير موجودة');
    if (!dto.code || dto.code === unit.code) {
      return this.prisma.unitOfMeasure.update({ where: { id }, data: dto });
    }

    const clash = await this.prisma.unitOfMeasure.findUnique({ where: { code: dto.code } });
    if (clash) throw new BadRequestException('يوجد وحدة قياس بهذا الكود بالفعل');

    // Every ingredient currently using the OLD code needs the rename to
    // "reflect on operations" (as requested) -- but only once it's safe:
    // once ANY of them has inventory movement, every quantity/cost ever
    // recorded for it is keyed to the current code string, so renaming out
    // from under it would silently orphan that history the same way
    // IngredientsService.update's own unit-field lock already prevents at
    // the single-ingredient level.
    const usingIngredients = await this.prisma.ingredient.findMany({ where: { unit: unit.code }, select: { id: true } });
    if (usingIngredients.length) {
      const movementCount = await this.prisma.inventoryBatch.count({ where: { ingredientId: { in: usingIngredients.map((i) => i.id) } } });
      if (movementCount > 0) {
        throw new BadRequestException(
          'لا يمكن تغيير كود وحدة القياس بعد وجود حركة مخزنية على أصناف تستخدمها -- كل الكميات والتكاليف المسجّلة مبنية على الكود الحالي',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.ingredient.updateMany({ where: { unit: unit.code }, data: { unit: dto.code } });
      return tx.unitOfMeasure.update({ where: { id }, data: dto });
    });
  }
}
