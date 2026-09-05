import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsNumber, IsPositive, IsString, ValidateNested } from 'class-validator';

export class RecipeLineInputDto {
  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;
}

export class SetRecipeDto {
  @IsArray()
  @ArrayUnique((line: RecipeLineInputDto) => line.ingredientId)
  @ValidateNested({ each: true })
  @Type(() => RecipeLineInputDto)
  lines!: RecipeLineInputDto[];
}
