import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsString, ValidateNested } from 'class-validator';
import { StocktakeLineInputDto } from './stocktake-lines.dto';

export class CreateStocktakeDto {
  @IsString()
  locationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StocktakeLineInputDto)
  lines!: StocktakeLineInputDto[];
}
