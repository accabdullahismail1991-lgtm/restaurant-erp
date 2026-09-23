import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IngredientKind, POStatus, ProductionStatus, TransferStatus } from '@prisma/client';
import { bulkImportRows } from '../common/bulk-import.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertUnitDto } from './dto/convert-unit.dto';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { SetRecipeDto } from './dto/set-recipe.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';

// Free-text spelling variants seen in the wild for each recognized unit --
// Ingredient.unit is a free string (see its schema comment), so an import
// or a manual entry may have used any of these instead of the exact
// UnitOfMeasure catalog name (e.g. "كجم" and "kg" are the same real unit,
// just spelled differently). Each map value is that variant's size relative
// to the family's smallest member (gram, milliliter, or piece) -- the same
// mass/volume/count families admin_panel.html's own UNIT_FAMILIES uses for
// recipe/purchasing quantity entry, kept in sync by hand since one is
// Prisma-side TypeScript and the other plain browser JS.
const MASS_UNITS: Record<string, number> = { جم: 1, جرام: 1, g: 1, gram: 1, grams: 1, كجم: 1000, كيلوجرام: 1000, كيلو: 1000, kg: 1000, kilo: 1000, kilogram: 1000 };
const VOLUME_UNITS: Record<string, number> = { مل: 1, مليلتر: 1, ml: 1, milliliter: 1, millilitre: 1, لتر: 1000, l: 1000, liter: 1000, litre: 1000 };
const COUNT_UNITS: Record<string, number> = { حبة: 1, قطعة: 1, pcs: 1, piece: 1, pieces: 1 };
const UNIT_FAMILIES = [MASS_UNITS, VOLUME_UNITS, COUNT_UNITS];

// Multiplier applied to QUANTITY fields to go from `fromUnit` to `toUnit`
// (cost fields get its inverse) -- 1 when both spell the exact same real
// unit (a pure relabel, e.g. "كجم" -> "kg"), the real ratio when they're
// different sizes within the same family (e.g. "g" -> "kg"), or null when
// the two aren't in any family together at all (nothing safe to infer).
function unitConversionFactor(fromUnit: string, toUnit: string): number | null {
  for (const family of UNIT_FAMILIES) {
    if (fromUnit in family && toUnit in family) return family[fromUnit] / family[toUnit];
  }
  return null;
}

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
    // Independent reads (none depends on another's result) -- run them
    // together instead of paying for 3 sequential round-trips on every
    // GET /ingredients, which nearly every admin-panel tab switch triggers
    // via ensureIngredientsCache().
    const [ingredients, batchCounts, saleRecipeCounts] = await Promise.all([
      this.prisma.ingredient.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.inventoryBatch.groupBy({ by: ['ingredientId'], _count: { ingredientId: true } }),
      // Lets the admin panel offer a RAW_MATERIAL for a manual production
      // order too (not just SEMI_FINISHED) when it's actually consumed by
      // some menu item's sale recipe -- a real, in-use ingredient, not just
      // theoretically producible. See ProductionOrdersService.create(),
      // which now allows any ingredient, with an empty (no-BOM) inputs list
      // for one that isn't SEMI_FINISHED.
      this.prisma.recipeLine.groupBy({ by: ['ingredientId'], where: { menuItemId: { not: null } }, _count: { ingredientId: true } }),
    ]);
    const withMovement = new Set(batchCounts.map((b) => b.ingredientId));
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

  // The other path to changing Ingredient.unit once there's real movement
  // -- update() above just refuses that outright, because a bare unit
  // swap would silently reinterpret every stored quantity/cost without
  // touching their numbers. This does the numbers too: rescales the
  // ingredient's own fields, every open batch (+ its movement history),
  // its live balance, and every recipe line that mentions it -- in BOTH
  // directions a component can appear in (as someone else's ingredient,
  // or as this ingredient's own BOM) -- so the same physical quantities
  // stay correct under the new unit. Covers any pair unitConversionFactor()
  // recognizes: a real magnitude change within a family (e.g. g -> kg), or
  // a pure relabel of the exact same unit (e.g. "كجم" -> "kg", factor 1) --
  // the latter matters because update() above can't do even that once
  // there's movement, despite it needing no math at all.
  //
  // Deliberately narrower than a "fix everything" migration: PLANNED/
  // IN_PROGRESS production, non-terminal purchase orders, in-transit
  // transfers and open stocktakes all carry their OWN snapshot quantities
  // (copied off the recipe/balance at creation time, not a live
  // reference), still expressed in the OLD unit and due to be acted on
  // later (start()/complete(), receive, stocktake approval...). Rescaling
  // those too would mean guessing at in-flight business state instead of
  // just refusing until it's resolved -- so this blocks on any of them
  // existing, the same "finish what's pending first" shape every other
  // guard in this codebase already uses (e.g. shift-close vs unpaid
  // orders). COMPLETED/CANCELLED/RECEIVED/REJECTED/terminal-status rows
  // are historical fact by then and are deliberately left untouched, same
  // as an invoice never gets rewritten after a currency redenomination.
  async convertUnit(id: string, dto: ConvertUnitDto) {
    const ingredient = await this.findOne(id);
    const fromUnit = ingredient.unit;
    const toUnit = dto.toUnit;

    // multiplier applied to QUANTITY fields; cost fields get 1/factor
    const factor = unitConversionFactor(fromUnit, toUnit);
    if (factor == null) {
      throw new BadRequestException('هذا التحويل غير مدعوم حاليًا -- الوحدتان ليستا من نفس نوع القياس (وزن/حجم/عدد) المعروف للنظام');
    }

    const [pendingProductionInput, pendingProductionOutput, pendingPurchase, pendingTransfer, pendingStocktake] = await Promise.all([
      this.prisma.productionOrderLine.count({ where: { ingredientId: id, productionOrder: { status: { in: [ProductionStatus.PLANNED, ProductionStatus.IN_PROGRESS] } } } }),
      this.prisma.productionOrder.count({ where: { outputIngredientId: id, status: { in: [ProductionStatus.PLANNED, ProductionStatus.IN_PROGRESS] } } }),
      this.prisma.purchaseOrderLine.count({ where: { ingredientId: id, purchaseOrder: { status: { in: [POStatus.DRAFT, POStatus.PENDING_APPROVAL, POStatus.APPROVED, POStatus.SENT_TO_SUPPLIER] } } } }),
      this.prisma.transferLine.count({ where: { ingredientId: id, transfer: { status: TransferStatus.DISPATCHED } } }),
      this.prisma.stocktakeLine.count({ where: { ingredientId: id, stocktake: { status: { in: ['IN_PROGRESS', 'PENDING_APPROVAL'] } } } }),
    ]);
    if (pendingProductionInput || pendingProductionOutput || pendingPurchase || pendingTransfer || pendingStocktake) {
      throw new BadRequestException(
        'لا يمكن تحويل وحدة هذا الصنف الآن -- له أوامر إنتاج أو شراء أو تحويلات أو جرد لم تُغلق بعد وتعتمد على الوحدة الحالية. أنهِ أو ألغِ هذه العمليات أولًا',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.inventoryBatch.updateMany({ where: { ingredientId: id }, data: { quantity: { multiply: factor }, unitCost: { divide: factor } } });
      await tx.stockMovement.updateMany({ where: { batch: { ingredientId: id } }, data: { quantity: { multiply: factor } } });
      await tx.inventoryBalance.updateMany({ where: { ingredientId: id }, data: { quantity: { multiply: factor } } });
      // as a component in someone else's recipe -- same role as stock quantity
      await tx.recipeLine.updateMany({ where: { ingredientId: id }, data: { quantity: { multiply: factor } } });
      // this ingredient's OWN BOM -- inverse factor (see the method comment)
      await tx.recipeLine.updateMany({ where: { parentIngredientId: id }, data: { quantity: { divide: factor } } });

      return tx.ingredient.update({
        where: { id },
        data: {
          unit: toUnit,
          lowStockThreshold: { multiply: factor },
          ...(ingredient.openingCost != null ? { openingCost: { divide: factor } } : {}),
        },
      });
    });
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
