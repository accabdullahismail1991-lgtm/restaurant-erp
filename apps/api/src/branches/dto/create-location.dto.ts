import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { LocationType } from '@prisma/client';

export class CreateLocationDto {
  @IsString()
  name!: string;

  @IsEnum(LocationType)
  type!: LocationType;

  @IsOptional()
  @IsString()
  address?: string;

  // KSA VAT registration numbers are always 15 digits, starting and ending
  // with 3 (ZATCA's own format rule) -- validated so a typo here doesn't
  // silently produce an invalid invoice later (Phase 9, ZatcaService).
  @IsOptional()
  @Matches(/^3\d{13}3$/, { message: 'الرقم الضريبي يجب أن يكون 15 رقمًا ويبدأ وينتهي بـ 3' })
  vatNumber?: string;

  @IsOptional()
  @IsBoolean()
  requireCustomerForOrders?: boolean;
}
