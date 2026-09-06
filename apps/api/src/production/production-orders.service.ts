import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IngredientKind, Prisma, ProductionStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionOrderDto } from './dto/create-production-order.dto';

@Injectable()
export class ProductionOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  async create(dto: CreateProductionOrderDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);

    const output = await this.prisma.ingredient.findUnique({ where: { id: dto.outputIngredientId } });
    if (!output) throw new BadRequestException('الصنف الناتج غير موجود');
    if (output.kind !== IngredientKind.SEMI_FINISHED) {
      throw new BadRequestException('لا يمكن إنشاء أمر إنتاج لصنف ليس "نصف مصنّع"');
    }

    let lines: Array<{ ingredientId: string; quantity: number }>;
    if (dto.lines) {
      const ids = [...new Set(dto.lines.map((l) => l.ingredientId))];
      const found = await this.prisma.ingredient.findMany({ where: { id: { in: ids } } });
      if (found.length !== ids.length) throw new BadRequestException('أحد المكوّنات المطلوبة غير موجود');
      lines = dto.lines;
    } else {
      // RecipeLine.quantity is defined per 1 unit of the parent -- the
      // same convention Sales already relies on for a menu item's recipe
      // (docs/ARCHITECTURE.md's "Sales <-> Items <-> Inventory") -- so
      // scaling by outputQuantity gives exactly what this run consumes.
      const recipe = await this.prisma.recipeLine.findMany({ where: { parentIngredientId: dto.outputIngredientId } });
      if (!recipe.length) {
        throw new BadRequestException('هذا الصنف ليس له وصفة مسجّلة -- حدد المكوّنات يدويًا (lines) أو سجّل وصفته أولًا');
      }
      lines = recipe.map((r) => ({ ingredientId: r.ingredientId, quantity: Number(r.quantity) * dto.outputQuantity }));
    }

    return this.prisma.productionOrder.create({
      data: {
        locationId: dto.locationId,
        outputIngredientId: dto.outputIngredientId,
        outputQuantity: dto.outputQuantity,
        inputs: { create: lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity })) },
      },
      include: { inputs: true },
    });
  }

  async findOne(id: string, userId: string) {
    const po = await this.prisma.productionOrder.findUnique({ where: { id }, include: { inputs: true } });
    if (!po) throw new NotFoundException('أمر الإنتاج غير موجود');
    await this.assertLocationInScope(userId, po.locationId);
    return po;
  }

  async findAll(userId: string, locationId?: string, status?: ProductionStatus) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.productionOrder.findMany({
      where: { locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined, status },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Consumes every input line atomically -- if the location is short on
  // any component, the whole start fails and nothing is consumed (same
  // atomicity guarantee Sales' order creation has). Captures the real
  // cost of what got consumed for complete() to price the output with.
  async start(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== ProductionStatus.PLANNED) throw new BadRequestException('أمر الإنتاج ليس في حالة "مخطط"');

    return this.prisma.$transaction(async (tx) => {
      let totalInputCost = new Prisma.Decimal(0);
      for (const line of po.inputs) {
        const { totalCost } = await this.inventory.consume(tx, {
          locationId: po.locationId,
          ingredientId: line.ingredientId,
          quantity: Number(line.quantity),
          reason: 'PRODUCTION_CONSUMPTION',
          refId: po.id,
        });
        totalInputCost = totalInputCost.add(totalCost);
      }
      return tx.productionOrder.update({
        where: { id },
        data: { status: ProductionStatus.IN_PROGRESS, startedAt: new Date(), totalInputCost },
        include: { inputs: true },
      });
    });
  }

  // The output batch's unit cost is exactly what its inputs cost --
  // totalInputCost captured at start() divided across outputQuantity --
  // not a guess, and never left at 0.
  async complete(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== ProductionStatus.IN_PROGRESS) throw new BadRequestException('أمر الإنتاج ليس قيد التنفيذ');

    const unitCost = Number(po.totalInputCost) / Number(po.outputQuantity);

    return this.prisma.$transaction(async (tx) => {
      await this.inventory.receive(tx, {
        locationId: po.locationId,
        ingredientId: po.outputIngredientId,
        quantity: Number(po.outputQuantity),
        unitCost,
        sourceType: 'PRODUCTION',
        sourceId: po.id,
        reason: 'PRODUCTION_OUTPUT',
      });
      return tx.productionOrder.update({ where: { id }, data: { status: ProductionStatus.COMPLETED, completedAt: new Date() } });
    });
  }

  // PLANNED -> nothing was consumed yet, just flip the status. IN_PROGRESS
  // -> reverse exactly what start() consumed, same batches, via
  // InventoryService.reverseConsumption (mirrors Sales' void). Not allowed
  // once COMPLETED -- the output already exists and may itself have been
  // consumed downstream, so reversing it needs a separate flow, same
  // boundary Sales draws around a PAID order.
  async cancel(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status === ProductionStatus.COMPLETED || po.status === ProductionStatus.CANCELLED) {
      throw new BadRequestException('لا يمكن إلغاء أمر إنتاج مكتمل أو ملغى بالفعل');
    }

    return this.prisma.$transaction(async (tx) => {
      if (po.status === ProductionStatus.IN_PROGRESS) {
        await this.inventory.reverseConsumption(tx, {
          refId: po.id,
          matchReason: 'PRODUCTION_CONSUMPTION',
          restockReason: 'PRODUCTION_CANCEL_RESTOCK',
        });
      }
      return tx.productionOrder.update({ where: { id }, data: { status: ProductionStatus.CANCELLED } });
    });
  }
}
