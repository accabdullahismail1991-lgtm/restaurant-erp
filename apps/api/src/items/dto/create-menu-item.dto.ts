import { TaxType } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateMenuItemDto {
  @IsString()
  name!: string;

  @IsString()
  category!: string;

  @IsNumber()
  @IsPositive()
  price!: number;

  @IsOptional()
  @IsEnum(TaxType)
  taxType?: TaxType;
}
