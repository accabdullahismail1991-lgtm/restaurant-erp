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

// Revalues every currently-open batch of this ingredient at this location
// to newUnitCost, WITHOUT touching quantity at all -- for when the counted
// stock is right but its recorded cost was wrong (a receiving typo, a
// supplier price correction after the fact, aligning book cost to a known
// replacement cost). See InventoryService.recordCostAdjustment.
export class CostAdjustmentDto {
  @IsString()
  locationId!: string;

  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  newUnitCost!: number;

  @IsOptional()
  @IsString()
  note?: string;
}
