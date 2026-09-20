import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IngredientKind, POStatus, ProductionStatus, TransferStatus } from '@prisma/client';
import { bulkImportRows } from '../common/bulk-import.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertUnitDto } from './dto/convert-unit.dto';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { SetRecipeDto } from './dto/set-recipe.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';

// Free-text spelling variants seen in the wild for the two units this
// conversion supports -- Ingredient.unit is a free string (see its schema
// comment), so an import or a manual entry may have used any of these for
// "gram" or "kilogram" rather than the exact UnitOfMeasure catalog name.
const GRAM_UNITS = new Set(['جم', 'جرام', 'g', 'gram', 'grams']);
const KG_UNITS = new Set(['كجم', 'كيلوجرام', 'كيلو', 'kg', 'kilo', 'kilogram']);

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
  // stay correct under the new unit. Currently only supports the gram<->kg
  // pair (see GRAM_UNITS/KG_UNITS) -- the only case asked for; extending
  // to ml<->l would just mean adding another pair with the same factor.
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

    let factor: number; // multiplier applied to QUANTITY fields; cost fields get 1/factor
    if (GRAM_UNITS.has(fromUnit) && KG_UNITS.has(toUnit)) factor = 1 / 1000;
    else if (KG_UNITS.has(fromUnit) && GRAM_UNITS.has(toUnit)) factor = 1000;
    else throw new BadRequestException('هذا التحويل غير مدعوم حاليًا -- التحويل متاح فقط بين الجرام والكيلوجرام');

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
