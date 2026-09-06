import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsPositive, IsString, ValidateNested } from 'class-validator';

export class TransferLineInputDto {
  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;
}

export class CreateTransferDto {
  @IsString()
  fromLocationId!: string;

  @IsString()
  toLocationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferLineInputDto)
  lines!: TransferLineInputDto[];
}
