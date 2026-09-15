import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { PromotionType } from '@prisma/client';

const IMPLEMENTED_TYPES = [PromotionType.PERCENTAGE_DISCOUNT, PromotionType.FIXED_DISCOUNT];

export class UpdatePromotionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(IMPLEMENTED_TYPES, { message: 'أنواع BOGO/COMBO غير مُنفَّذة بعد في محرك تطبيق العروض' })
  type?: PromotionType;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  value?: number;

  @IsOptional()
  @IsString()
  channelLimit?: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
