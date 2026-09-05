import { IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { IngredientKind, ValuationMethod } from '@prisma/client';

export class CreateIngredientDto {
  @IsString()
  name!: string;

  @IsString()
  unit!: string;

  @IsEnum(IngredientKind)
  kind!: IngredientKind;

  @IsOptional()
  @IsEnum(ValuationMethod)
  valuationMethod?: ValuationMethod;

  @IsNumber()
  @Min(0)
  lowStockThreshold!: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  shelfLifeDays?: number;
}
