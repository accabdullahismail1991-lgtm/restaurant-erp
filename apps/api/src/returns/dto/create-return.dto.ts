import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';

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
}
