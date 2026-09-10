import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';

export class CreatePurchaseReturnLineDto {
  @IsString()
  purchaseOrderLineId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;
}

export class CreatePurchaseReturnDto {
  @IsString()
  purchaseOrderId!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseReturnLineDto)
  lines!: CreatePurchaseReturnLineDto[];
}
