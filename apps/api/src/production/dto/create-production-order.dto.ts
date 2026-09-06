import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';

export class ProductionInputLineDto {
  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;
}

export class CreateProductionOrderDto {
  @IsString()
  locationId!: string;

  @IsString()
  outputIngredientId!: string;

  @IsNumber()
  @IsPositive()
  outputQuantity!: number;

  // Omitted = auto-derive from the output ingredient's OWN recipe
  // (RecipeLine.parentIngredientId), scaled by outputQuantity. Provided =
  // override for this specific run (e.g. substituting a component that's
  // out of stock) -- see ProductionOrdersService.create.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductionInputLineDto)
  lines?: ProductionInputLineDto[];
}
