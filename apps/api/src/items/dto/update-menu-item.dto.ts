import { TaxType } from '@prisma/client';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class UpdateMenuItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number;

  @IsOptional()
  @IsEnum(TaxType)
  taxType?: TaxType;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
