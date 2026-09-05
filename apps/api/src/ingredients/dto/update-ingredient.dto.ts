import { IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { IngredientKind, ValuationMethod } from '@prisma/client';

export class UpdateIngredientDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsEnum(IngredientKind)
  kind?: IngredientKind;

  @IsOptional()
  @IsEnum(ValuationMethod)
  valuationMethod?: ValuationMethod;

  @IsOptional()
  @IsNumber()
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  shelfLifeDays?: number;
}
