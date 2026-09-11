import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, ValidateNested } from 'class-validator';
import { InvoiceType, OrderChannel } from '@prisma/client';

export class CreateOrderLineDto {
  @IsString()
  menuItemId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;
}

export class CreateOrderDto {
  @IsString()
  locationId!: string;

  @IsString()
  shiftId!: string;

  @IsIn(Object.values(OrderChannel))
  channel!: OrderChannel;

  @IsOptional()
  @IsString()
  tableId?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  // Defaults to CASH -- CREDIT (آجل) requires customerId, enforced in
  // OrdersService.create() since it billed to a specific customer's
  // account by definition.
  @IsOptional()
  @IsIn(Object.values(InvoiceType))
  invoiceType?: InvoiceType;

  // Separate from `channel` above (the general dine-in/takeaway/delivery
  // classification used by analytics/promotions) -- this picks a specific
  // SalesChannel price list (e.g. "هنجر ستيشن") so order lines are priced
  // by that channel's overrides instead of each item's base price.
  @IsOptional()
  @IsString()
  salesChannelId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountTotal?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderLineDto)
  lines!: CreateOrderLineDto[];
}
