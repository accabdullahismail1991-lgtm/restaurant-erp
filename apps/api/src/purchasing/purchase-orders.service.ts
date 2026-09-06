import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { POStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalRulesService } from './approval-rules.service';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalRules: ApprovalRulesService,
    private readonly inventory: InventoryService,
  ) {}

  private async assertLocationInScope(userId: string, locationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
  }

  async create(dto: CreatePurchaseOrderDto, userId: string) {
    await this.assertLocationInScope(userId, dto.locationId);

    const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new BadRequestException('المورد غير موجود');
    if (supplier.scopeLocationId && supplier.scopeLocationId !== dto.locationId) {
      throw new BadRequestException('هذا المورد غير متاح لهذا الموقع');
    }

    const ingredientIds = [...new Set(dto.lines.map((l) => l.ingredientId))];
    const ingredients = await this.prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
    if (ingredients.length !== ingredientIds.length) {
      throw new BadRequestException('أحد المكوّنات المطلوبة غير موجود');
    }

    const totalAmount = round2(dto.lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));

    return this.prisma.purchaseOrder.create({
      data: {
        locationId: dto.locationId,
        supplierId: dto.supplierId,
        createdById: userId,
        totalAmount,
        lines: { create: dto.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity, unitCost: l.unitCost })) },
      },
      include: { lines: true },
    });
  }

  async findOne(id: string, userId: string) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true, approvals: true } });
    if (!po) throw new NotFoundException('أمر الشراء غير موجود');
    await this.assertLocationInScope(userId, po.locationId);
    return po;
  }

  async findAll(userId: string, locationId?: string, status?: POStatus) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.purchaseOrder.findMany({
      where: { locationId: locationId ? locationId : allowedIds ? { in: allowedIds } : undefined, status },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Applies the Approval Matrix (docs/DECISIONS.md #8): no rule covering
  // this PO's amount/location = nothing gates it, so it's auto-approved;
  // a rule found = it needs that specific rule's role to sign off, so it
  // waits in PENDING_APPROVAL.
  async submit(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== POStatus.DRAFT) throw new BadRequestException('لا يمكن تقديم أمر شراء ليس في حالة مسودة');

    const rule = await this.approvalRules.findApplicableRule('PURCHASE_ORDER', po.locationId, Number(po.totalAmount));
    const nextStatus = rule ? POStatus.PENDING_APPROVAL : POStatus.APPROVED;
    return this.prisma.purchaseOrder.update({ where: { id }, data: { status: nextStatus } });
  }

  private async assertHasApprovalRole(po: { locationId: string; totalAmount: unknown }, userId: string) {
    const rule = await this.approvalRules.findApplicableRule('PURCHASE_ORDER', po.locationId, Number(po.totalAmount));
    if (!rule) return; // no rule configured any more (e.g. deleted after submit) -- nothing to check
    const holdsRole = await this.prisma.userRole.findFirst({ where: { userId, roleId: rule.requiredRoleId } });
    if (!holdsRole) {
      throw new ForbiddenException('لا تملك الدور المطلوب لاعتماد أمر شراء بهذا المبلغ حسب مصفوفة الموافقات');
    }
  }

  async approve(id: string, dto: ApprovalDecisionDto, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== POStatus.PENDING_APPROVAL) throw new BadRequestException('أمر الشراء ليس بانتظار الموافقة');
    await this.assertHasApprovalRole(po, userId);

    return this.prisma.$transaction(async (tx) => {
      await tx.approval.create({ data: { purchaseOrderId: id, approvedById: userId, decision: 'APPROVED', note: dto.note } });
      return tx.purchaseOrder.update({ where: { id }, data: { status: POStatus.APPROVED } });
    });
  }

  async reject(id: string, dto: ApprovalDecisionDto, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== POStatus.PENDING_APPROVAL) throw new BadRequestException('أمر الشراء ليس بانتظار الموافقة');
    await this.assertHasApprovalRole(po, userId);

    return this.prisma.$transaction(async (tx) => {
      await tx.approval.create({ data: { purchaseOrderId: id, approvedById: userId, decision: 'REJECTED', note: dto.note } });
      return tx.purchaseOrder.update({ where: { id }, data: { status: POStatus.REJECTED } });
    });
  }

  async send(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== POStatus.APPROVED) throw new BadRequestException('أمر الشراء ليس معتمدًا بعد');
    return this.prisma.purchaseOrder.update({ where: { id }, data: { status: POStatus.SENT_TO_SUPPLIER } });
  }

  // Receiving is the real inventory event: every line becomes its own
  // InventoryBatch (sourceType=PURCHASE, sourceId=this PO), atomically
  // with the status flip -- reusing InventoryService.receive rather than
  // re-deriving batch/movement/balance bookkeeping here.
  async receive(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status !== POStatus.APPROVED && po.status !== POStatus.SENT_TO_SUPPLIER) {
      throw new BadRequestException('لا يمكن استلام أمر شراء إلا بعد اعتماده');
    }

    return this.prisma.$transaction(async (tx) => {
      for (const line of po.lines) {
        await this.inventory.receive(tx, {
          locationId: po.locationId,
          ingredientId: line.ingredientId,
          quantity: Number(line.quantity),
          unitCost: Number(line.unitCost),
          sourceType: 'PURCHASE',
          sourceId: po.id,
          reason: 'PURCHASE_RECEIPT',
        });
      }
      return tx.purchaseOrder.update({ where: { id }, data: { status: POStatus.RECEIVED }, include: { lines: true } });
    });
  }

  async cancel(id: string, userId: string) {
    const po = await this.findOne(id, userId);
    if (po.status === POStatus.RECEIVED || po.status === POStatus.CANCELLED) {
      throw new BadRequestException('لا يمكن إلغاء أمر شراء مستلم أو ملغى بالفعل');
    }
    return this.prisma.purchaseOrder.update({ where: { id }, data: { status: POStatus.CANCELLED } });
  }
}
