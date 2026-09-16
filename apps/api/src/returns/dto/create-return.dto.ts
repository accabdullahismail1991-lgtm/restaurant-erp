import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';

export class CreateReturnLineDto {
  @IsString()
  orderLineId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;
}

export class CreateReturnDto {
  @IsString()
  orderId!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateReturnLineDto)
  lines!: CreateReturnLineDto[];

  // Caller's intent to bypass the "line hasn't left the kitchen yet" block
  // below -- ReturnsService.create() only actually honors this when the
  // requesting user holds pos.override_kitchen_block; a caller without it
  // sending true gets the same 400 as sending nothing, never a 403 (the
  // block itself is the enforcement, not a separate permission gate on
  // this field).
  @IsOptional()
  @IsBoolean()
  overrideKitchenBlock?: boolean;
}
