import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsString, Min, ValidateNested } from 'class-validator';

export class StocktakeLineInputDto {
  @IsString()
  ingredientId!: string;

  // The physically counted quantity -- compared against the system's
  // current InventoryBalance at submission time to derive the variance.
  @IsNumber()
  @Min(0)
  countedQuantity!: number;
}

export class SetStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StocktakeLineInputDto)
  lines!: StocktakeLineInputDto[];
}
