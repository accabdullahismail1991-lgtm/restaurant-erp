import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class ReceiveInventoryDto {
  @IsString()
  locationId!: string;

  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsNumber()
  @IsPositive()
  unitCost!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class WasteInventoryDto {
  @IsString()
  locationId!: string;

  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
