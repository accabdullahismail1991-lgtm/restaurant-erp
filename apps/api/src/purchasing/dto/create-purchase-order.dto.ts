import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { TaxType } from '@prisma/client';

export class PurchaseOrderLineInputDto {
  @IsString()
  ingredientId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsNumber()
  @IsPositive()
  unitCost!: number;

  @IsOptional()
  @IsEnum(TaxType)
  taxType?: TaxType;
}

export class CreatePurchaseOrderDto {
  @IsString()
  locationId!: string;

  @IsString()
  supplierId!: string;

  // مطابق لهيئة فاتورة المورد: هل سعر الوحدة المُدخل في كل سطر شامل الضريبة
  // أم لا -- انظر تعليق PurchaseOrder.pricesIncludeVat في schema.prisma.
  @IsOptional()
  @IsBoolean()
  pricesIncludeVat?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineInputDto)
  lines!: PurchaseOrderLineInputDto[];
}
