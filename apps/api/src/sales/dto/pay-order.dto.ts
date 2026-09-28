import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
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

  // Requires pos.backdate_shift (see OrdersService.pay) -- the real moment
  // a sale genuinely happened, for sales migrated from another system that
  // never had a ZATCA invoice issued for them (never for a routine sale:
  // ZATCA's issue-date/hash-chain integrity depends on this normally being
  // "now"). Must fall on the order's own already-recorded businessDate.
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}
