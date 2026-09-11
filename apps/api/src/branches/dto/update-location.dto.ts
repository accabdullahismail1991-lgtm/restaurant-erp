import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
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
  @IsString()
  invoiceHeaderNote?: string;

  @IsOptional()
  @IsString()
  invoiceFooterNote?: string;
}
