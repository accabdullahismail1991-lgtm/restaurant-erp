import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { PaymentMode } from '@prisma/client';

export class PaymentInputDto {
  @IsString()
  method!: string; // "CASH" | "CARD" | "WALLET"

  @IsIn(Object.values(PaymentMode))
  mode!: PaymentMode;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  terminalRef?: string;
}

export class PayOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments!: PaymentInputDto[];
}
