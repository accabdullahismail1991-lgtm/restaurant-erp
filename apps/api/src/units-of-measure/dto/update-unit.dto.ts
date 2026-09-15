import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateUnitDto {
  // Renaming the CODE cascades to every Ingredient.unit that used the old
  // one (see UnitsOfMeasureService.update) -- only allowed when none of
  // those ingredients has any inventory movement yet, same guard
  // IngredientsService.update already applies to a single ingredient's own
  // unit field, extended here since a code rename affects potentially many
  // ingredients at once.
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
