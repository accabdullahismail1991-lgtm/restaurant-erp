import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { InvoiceType } from '@prisma/client';

// Which specific item the cashier picked for one combo slot -- quantity
// lets a slot with maxSelect > 1 pick the SAME item more than once (e.g.
// "2 sides, either the same or different") without needing one entry per
// unit.
export class ComboSelectionInputDto {
  @IsString()
  comboSlotId!: string;

  @IsString()
  menuItemId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;
}

// menuItemId XOR comboMealId -- exactly one, enforced in
// OrdersService.create() (class-validator has no clean cross-field XOR
// check). A combo line's comboSelections are what OrdersService actually
// validates against the combo's own slots/options and consumes inventory
// for -- they are NOT separate OrderLines.
export class CreateOrderLineDto {
  @IsOptional()
  @IsString()
  menuItemId?: string;

  @IsOptional()
  @IsString()
  comboMealId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboSelectionInputDto)
  comboSelections?: ComboSelectionInputDto[];

  @IsInt()
  @IsPositive()
  quantity!: number;

  // Free-text kitchen instruction for this specific line (e.g. "بدون
  // بصل") -- persisted verbatim on OrderLine.note, shown under this line
  // on the invoice, the KDS ticket, and the printable kitchen ticket.
  // Never parsed/validated beyond length, and never affects pricing or
  // inventory.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class CreateOrderDto {
  @IsString()
  locationId!: string;

  @IsString()
  shiftId!: string;

  // References OrderType.code -- checked against the OrderType table (must
  // exist and be active) in OrdersService.create() instead of a compile-time
  // enum, since order types are now admin-manageable.
  @IsString()
  channel!: string;

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
