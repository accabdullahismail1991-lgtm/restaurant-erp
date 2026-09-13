import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayUnique, IsArray, IsInt, IsNumber, IsPositive, IsString, Min, ValidateNested } from 'class-validator';

export class ComboSlotOptionInputDto {
  @IsString()
  menuItemId!: string;

  @IsNumber()
  @Min(0)
  extraPrice!: number;
}

export class ComboSlotInputDto {
  @IsString()
  label!: string;

  @IsInt()
  @Min(1)
  minSelect!: number;

  @IsInt()
  @Min(1)
  maxSelect!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((o: ComboSlotOptionInputDto) => o.menuItemId)
  @ValidateNested({ each: true })
  @Type(() => ComboSlotOptionInputDto)
  options!: ComboSlotOptionInputDto[];
}

export class CreateComboDto {
  @IsString()
  name!: string;

  @IsNumber()
  @IsPositive()
  basePrice!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComboSlotInputDto)
  slots!: ComboSlotInputDto[];
}
