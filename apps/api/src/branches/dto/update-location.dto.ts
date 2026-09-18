import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { LocationType } from '@prisma/client';

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(LocationType)
  type?: LocationType;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @Matches(/^3\d{13}3$/, { message: 'الرقم الضريبي يجب أن يكون 15 رقمًا ويبدأ وينتهي بـ 3' })
  vatNumber?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  requireCustomerForOrders?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  vatRate?: number;

  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean;

  @IsOptional()
  @IsBoolean()
  pricesIncludeVat?: boolean;

  @IsOptional()
  @IsBoolean()
  autoCloseEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(23)
  autoCloseCutoffHour?: number;

  // Both set together (or both explicitly null to clear) -- BranchesService.
  // update() enforces the pairing and that the day is valid for the month;
  // the null-vs-undefined distinction (ValidateIf) follows the same
  // "explicit null clears it, undefined leaves it alone" pattern
  // UpdateCustomerDto.defaultSalesChannelId already uses.
  @IsOptional()
  @ValidateIf((o) => o.fiscalYearEndMonth !== null)
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearEndMonth?: number | null;

  @IsOptional()
  @ValidateIf((o) => o.fiscalYearEndDay !== null)
  @IsInt()
  @Min(1)
  @Max(31)
  fiscalYearEndDay?: number | null;

  @IsOptional()
  @IsString()
  invoiceHeaderNote?: string;

  @IsOptional()
  @IsString()
  invoiceFooterNote?: string;
}
