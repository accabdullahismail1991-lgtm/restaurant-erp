import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

class IngredientCostChangeDto {
  @IsString()
  ingredientId!: string;

  @IsNumber()
  @Min(0)
  newUnitCost!: number;
}

export class CostImpactSimulationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IngredientCostChangeDto)
  ingredientChanges!: IngredientCostChangeDto[];

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}
