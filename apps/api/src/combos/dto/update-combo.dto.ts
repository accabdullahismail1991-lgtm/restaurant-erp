import { IsBoolean, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

// Deliberately does NOT allow editing slots/options once a combo exists:
// ComboSelection rows on real past orders reference a specific
// ComboSlot/ComboSlotOption, and those FKs are left at Prisma's default
// RESTRICT (no onDelete: Cascade) precisely so a slot/option can never be
// silently deleted out from under historical orders. If the combo's
// structure needs to change, deactivate it (isActive: false) and create a
// new one -- the same "don't mutate what's already been sold" principle
// MenuItem.price already follows implicitly (changing it never rewrites a
// past OrderLine.unitPrice).
export class UpdateComboDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  basePrice?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
