import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
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
}
