import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { OrderChannel, PromotionType } from '@prisma/client';

// BOGO/COMBO stay valid Promotion.type values in the schema for later, but
// the apply-engine (PromotionsService.findApplicablePromotion) only knows
// how to compute PERCENTAGE_DISCOUNT/FIXED_DISCOUNT -- refusing to create
// the other two here means an admin never ends up with a "promotion" that
// looks saved but silently never discounts anything.
const IMPLEMENTED_TYPES = [PromotionType.PERCENTAGE_DISCOUNT, PromotionType.FIXED_DISCOUNT];

export class CreatePromotionDto {
  @IsString()
  name!: string;

  @IsIn(IMPLEMENTED_TYPES, { message: 'أنواع BOGO/COMBO غير مُنفَّذة بعد في محرك تطبيق العروض' })
  type!: PromotionType;

  @IsNumber()
  @IsPositive()
  value!: number;

  @IsOptional()
  @IsIn(Object.values(OrderChannel))
  channelLimit?: OrderChannel;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
