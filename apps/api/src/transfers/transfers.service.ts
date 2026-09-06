import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TransferStatus } from '@prisma/client';
import { scopedLocationIds } from '../common/location-scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { ReceiveTransferDto } from './dto/receive-transfer.dto';

@Injectable()
export class TransfersService {
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

  // Dispatching consumes every line from the SOURCE location atomically --
  // a shortfall in any one ingredient fails the whole transfer, nothing
  // leaves the shelf half-dispatched (same guarantee Sales/Production
  // give their own stock movements). Captures each line's real
  // consumed cost (from whichever batches actually got depleted) so the
  // destination batch can be priced accurately on receipt, not guessed.
  async create(dto: CreateTransferDto, userId: string) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('لا يمكن أن يكون موقع المصدر والوجهة نفس الموقع');
    }
    await this.assertLocationInScope(userId, dto.fromLocationId);

    const ids = [...new Set(dto.lines.map((l) => l.ingredientId))];
    const found = await this.prisma.ingredient.findMany({ where: { id: { in: ids } } });
    if (found.length !== ids.length) throw new BadRequestException('أحد المكوّنات المطلوبة غير موجود');

    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.transfer.create({
        data: { fromLocationId: dto.fromLocationId, toLocationId: dto.toLocationId },
      });

      for (const line of dto.lines) {
        const { totalCost } = await this.inventory.consume(tx, {
          locationId: dto.fromLocationId,
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          reason: 'TRANSFER_OUT',
          refId: transfer.id,
        });
        await tx.transferLine.create({
          data: {
            transferId: transfer.id,
            ingredientId: line.ingredientId,
            quantitySent: line.quantity,
            unitCost: totalCost.div(line.quantity),
          },
        });
      }

      return tx.transfer.findUniqueOrThrow({ where: { id: transfer.id }, include: { lines: true } });
    });
  }

  async findOne(id: string, userId: string) {
    const transfer = await this.prisma.transfer.findUnique({ where: { id }, include: { lines: true } });
    if (!transfer) throw new NotFoundException('التحويل غير موجود');
    await this.assertEitherEndInScope(userId, transfer.fromLocationId, transfer.toLocationId);
    return transfer;
  }

  // A user can see a transfer if they're scoped to EITHER end -- the
  // sender and the receiver aren't necessarily the same person/branch.
  private async assertEitherEndInScope(userId: string, fromLocationId: string, toLocationId: string) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (allowedIds && !allowedIds.includes(fromLocationId) && !allowedIds.includes(toLocationId)) {
      throw new ForbiddenException('هذا التحويل خارج نطاق صلاحيتك');
    }
  }

  async findAll(userId: string, locationId?: string, status?: TransferStatus) {
    const allowedIds = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowedIds && !allowedIds.includes(locationId)) {
      throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    }
    return this.prisma.transfer.findMany({
      where: {
        status,
        ...(locationId
          ? { OR: [{ fromLocationId: locationId }, { toLocationId: locationId }] }
          : allowedIds
            ? { OR: [{ fromLocationId: { in: allowedIds } }, { toLocationId: { in: allowedIds } }] }
            : {}),
      },
      orderBy: { dispatchedAt: 'desc' },
    });
  }

  // Receiving credits the DESTINATION with exactly what arrived, priced at
  // what it actually cost to send (TransferLine.unitCost captured at
  // dispatch) -- never more than what was sent. Any shortfall between
  // quantitySent and quantityReceived is transit loss (docs/DECISIONS.md
  // #6): it's a derived fact from the two stored quantities, not a
  // separate ledger entry -- the source already lost that stock the
  // moment it was dispatched.
  async receive(id: string, dto: ReceiveTransferDto, userId: string) {
    const transfer = await this.prisma.transfer.findUnique({ where: { id }, include: { lines: true } });
    if (!transfer) throw new NotFoundException('التحويل غير موجود');
    if (transfer.status !== TransferStatus.DISPATCHED) {
      throw new BadRequestException('هذا التحويل تم استلامه بالفعل');
    }
    await this.assertLocationInScope(userId, transfer.toLocationId);

    const byIngredient = new Map(dto.lines.map((l) => [l.ingredientId, l.quantityReceived]));
    if (transfer.lines.some((l) => !byIngredient.has(l.ingredientId))) {
      throw new BadRequestException('يجب تحديد الكمية المُستلَمة لكل مكوّن في التحويل');
    }

    let anyShortfall = false;
    for (const line of transfer.lines) {
      const quantityReceived = byIngredient.get(line.ingredientId)!;
      if (quantityReceived > Number(line.quantitySent)) {
        throw new BadRequestException('الكمية المُستلَمة لا يمكن أن تتجاوز الكمية المُرسَلة');
      }
      if (quantityReceived < Number(line.quantitySent)) anyShortfall = true;
    }

    return this.prisma.$transaction(async (tx) => {
      for (const line of transfer.lines) {
        const quantityReceived = byIngredient.get(line.ingredientId)!;
        await tx.transferLine.update({ where: { id: line.id }, data: { quantityReceived } });
        if (quantityReceived > 0) {
          await this.inventory.receive(tx, {
            locationId: transfer.toLocationId,
            ingredientId: line.ingredientId,
            quantity: quantityReceived,
            unitCost: Number(line.unitCost),
            sourceType: 'TRANSFER',
            sourceId: transfer.id,
            reason: 'TRANSFER_IN',
          });
        }
      }
      return tx.transfer.update({
        where: { id },
        data: {
          status: anyShortfall ? TransferStatus.RECEIVED_WITH_VARIANCE : TransferStatus.RECEIVED,
          receivedAt: new Date(),
        },
        include: { lines: true },
      });
    });
  }
}
