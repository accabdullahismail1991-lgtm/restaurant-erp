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

  // `hasMovement` tells the admin panel whether it's safe to let the unit
  // field be edited -- once ANY InventoryBatch exists for an ingredient
  // (a receipt, a production output, an adjustment, a transfer-in), every
  // quantity/cost ever recorded against it is expressed in its CURRENT
  // unit; changing the unit afterwards wouldn't convert those numbers, it
  // would just silently reinterpret them. A batch existing is a reliable
  // proxy for "has any movement at all", since every consumption event
  // (sales, waste, production input...) draws down an existing batch --
  // zero batches means zero consumption too.
  async findAll() {
    const ingredients = await this.prisma.ingredient.findMany({ orderBy: { name: 'asc' } });
    const batchCounts = await this.prisma.inventoryBatch.groupBy({ by: ['ingredientId'], _count: { ingredientId: true } });
    const withMovement = new Set(batchCounts.map((b) => b.ingredientId));
    // Lets the admin panel offer a RAW_MATERIAL for a manual production
    // order too (not just SEMI_FINISHED) when it's actually consumed by
    // some menu item's sale recipe -- a real, in-use ingredient, not just
    // theoretically producible. See ProductionOrdersService.create(),
    // which now allows any ingredient, with an empty (no-BOM) inputs list
    // for one that isn't SEMI_FINISHED.
    const saleRecipeCounts = await this.prisma.recipeLine.groupBy({
      by: ['ingredientId'],
      where: { menuItemId: { not: null } },
      _count: { ingredientId: true },
    });
    const usedInSaleRecipe = new Set(saleRecipeCounts.map((r) => r.ingredientId));
    return ingredients.map((i) => ({ ...i, hasMovement: withMovement.has(i.id), usedInSaleRecipe: usedInSaleRecipe.has(i.id) }));
  }

  async findOne(id: string) {
    const ingredient = await this.prisma.ingredient.findUnique({ where: { id } });
    if (!ingredient) throw new NotFoundException('الصنف غير موجود');
    const batchCount = await this.prisma.inventoryBatch.count({ where: { ingredientId: id } });
    return { ...ingredient, hasMovement: batchCount > 0 };
  }

  async update(id: string, dto: UpdateIngredientDto) {
    const existing = await this.prisma.ingredient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الصنف غير موجود');
    if (dto.unit && dto.unit !== existing.unit) {
      const movementCount = await this.prisma.inventoryBatch.count({ where: { ingredientId: id } });
      if (movementCount > 0) {
        throw new BadRequestException('لا يمكن تغيير وحدة القياس بعد وجود حركة مخزنية على هذا الصنف -- كل الكميات والتكاليف المسجّلة مبنية على الوحدة الحالية');
      }
    }
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
