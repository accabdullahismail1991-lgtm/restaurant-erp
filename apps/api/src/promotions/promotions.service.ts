import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderChannel, Promotion, PromotionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

function validate(type: PromotionType | undefined, value: number | undefined, startsAt?: string, endsAt?: string) {
  if (type === PromotionType.PERCENTAGE_DISCOUNT && value != null && value > 100) {
    throw new BadRequestException('نسبة الخصم يجب ألا تتجاوز 100%');
  }
  if (startsAt && endsAt && new Date(startsAt) > new Date(endsAt)) {
    throw new BadRequestException('تاريخ البداية يجب أن يسبق تاريخ النهاية');
  }
}

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreatePromotionDto) {
    validate(dto.type, dto.value, dto.startsAt, dto.endsAt);
    return this.prisma.promotion.create({
      data: {
        name: dto.name,
        type: dto.type,
        value: dto.value,
        channelLimit: dto.channelLimit,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  findAll() {
    return this.prisma.promotion.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const promotion = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promotion) throw new NotFoundException('العرض غير موجود');
    return promotion;
  }

  async update(id: string, dto: UpdatePromotionDto) {
    const existing = await this.findOne(id);
    validate(dto.type ?? existing.type, dto.value ?? Number(existing.value ?? 0), dto.startsAt, dto.endsAt);
    return this.prisma.promotion.update({
      where: { id },
      data: {
        name: dto.name,
        type: dto.type,
        value: dto.value,
        channelLimit: dto.channelLimit,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
        isActive: dto.isActive,
      },
    });
  }

  // Called from OrdersService.create() -- a separate calculation layer on
  // top of base pricing (docs/DECISIONS.md #14), never mixed into the
  // subtotal/VAT math itself. Only PERCENTAGE_DISCOUNT/FIXED_DISCOUNT are
  // ever candidates (BOGO/COMBO can't even be created, see the DTO).
  // Tie-break mirrors ApprovalRulesService.findApplicableRule: a
  // channel-specific promotion beats a channel-agnostic one; among
  // equally specific candidates, the one giving the bigger discount wins.
  async findApplicablePromotion(
    channel: OrderChannel,
    subtotal: number,
    at: Date = new Date(),
  ): Promise<{ promotion: Promotion; discount: number } | null> {
    const candidates = await this.prisma.promotion.findMany({
      where: {
        isActive: true,
        type: { in: [PromotionType.PERCENTAGE_DISCOUNT, PromotionType.FIXED_DISCOUNT] },
        OR: [{ channelLimit: null }, { channelLimit: channel }],
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: at } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: at } }] }],
      },
    });
    if (!candidates.length) return null;

    const scored = candidates.map((promotion) => {
      const value = Number(promotion.value ?? 0);
      const discount =
        promotion.type === PromotionType.PERCENTAGE_DISCOUNT
          ? round2(Math.min(subtotal, subtotal * (value / 100)))
          : round2(Math.min(subtotal, value));
      return { promotion, discount };
    });

    scored.sort((a, b) => {
      const aSpecific = a.promotion.channelLimit !== null ? 1 : 0;
      const bSpecific = b.promotion.channelLimit !== null ? 1 : 0;
      if (aSpecific !== bSpecific) return bSpecific - aSpecific;
      return b.discount - a.discount;
    });

    return scored[0];
  }
}
