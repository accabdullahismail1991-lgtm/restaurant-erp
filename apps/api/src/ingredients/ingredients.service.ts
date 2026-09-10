import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IngredientKind } from '@prisma/client';
import { bulkImportRows } from '../common/bulk-import.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { SetRecipeDto } from './dto/set-recipe.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';

@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateIngredientDto) {
    return this.prisma.ingredient.create({ data: dto });
  }

  bulkImport(rows: unknown[]) {
    return bulkImportRows(CreateIngredientDto, rows, (dto) => this.create(dto));
  }

  findAll() {
    return this.prisma.ingredient.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const ingredient = await this.prisma.ingredient.findUnique({ where: { id } });
    if (!ingredient) throw new NotFoundException('الصنف غير موجود');
    return ingredient;
  }

  async update(id: string, dto: UpdateIngredientDto) {
    await this.findOne(id);
    return this.prisma.ingredient.update({ where: { id }, data: dto });
  }

  async getRecipe(id: string) {
    await this.findOne(id);
    const lines = await this.prisma.recipeLine.findMany({
      where: { parentIngredientId: id },
      include: { ingredient: { select: { id: true, name: true, unit: true, kind: true } } },
    });
    return lines.map((l) => ({ id: l.id, quantity: l.quantity, ingredient: l.ingredient }));
  }

  // Replaces the FULL set of components this (semi-finished) ingredient is
  // made from. Only meaningful for kind===SEMI_FINISHED -- a raw material
  // is bought, not manufactured, so it can't have a recipe of its own.
  async setRecipe(id: string, dto: SetRecipeDto) {
    const parent = await this.findOne(id);
    if (parent.kind !== IngredientKind.SEMI_FINISHED) {
      throw new BadRequestException('الوصفة (BOM) متاحة فقط للأصناف من نوع "نصف مصنّع"');
    }

    const componentIds = dto.lines.map((l) => l.ingredientId);
    if (componentIds.includes(id)) {
      throw new BadRequestException('لا يمكن أن يكون الصنف مكوّنًا لنفسه');
    }

    const components = await this.prisma.ingredient.findMany({ where: { id: { in: componentIds } } });
    if (components.length !== new Set(componentIds).size) {
      throw new BadRequestException('أحد المكوّنات المذكورة غير موجود');
    }

    for (const componentId of componentIds) {
      if (await this.hasTransitivePathTo(componentId, id)) {
        const name = components.find((c) => c.id === componentId)?.name ?? componentId;
        throw new BadRequestException(
          `لا يمكن إضافة "${name}" كمكوّن -- ده هيعمل دورة (Cycle) لأنه بيعتمد بالفعل على "${parent.name}" في مستوى أعمق من الوصفة`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.recipeLine.deleteMany({ where: { parentIngredientId: id } });
      if (dto.lines.length) {
        await tx.recipeLine.createMany({
          data: dto.lines.map((l) => ({ parentIngredientId: id, ingredientId: l.ingredientId, quantity: l.quantity })),
        });
      }
      return tx.recipeLine.findMany({
        where: { parentIngredientId: id },
        include: { ingredient: { select: { id: true, name: true, unit: true, kind: true } } },
      });
    });
  }

  // True if `fromId`'s own recipe (transitively) already includes `toId`
  // as a component -- i.e. adding toId's recipe to depend on fromId would
  // close a cycle. DFS over ownRecipe (parentIngredientId) edges only --
  // that's the only edge type that can ever form a cycle here.
  private async hasTransitivePathTo(fromId: string, toId: string, visited = new Set<string>()): Promise<boolean> {
    if (fromId === toId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    const lines = await this.prisma.recipeLine.findMany({
      where: { parentIngredientId: fromId },
      select: { ingredientId: true },
    });
    for (const line of lines) {
      if (await this.hasTransitivePathTo(line.ingredientId, toId, visited)) return true;
    }
    return false;
  }
}
