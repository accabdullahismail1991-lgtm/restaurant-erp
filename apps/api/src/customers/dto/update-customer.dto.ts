import { IsOptional, IsString, ValidateIf } from 'class-validator';

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // Same as CreateCustomerDto -- null explicitly clears the link back to
  // "no default price list" (base MenuItem.price applies again).
  @IsOptional()
  @ValidateIf((o) => o.defaultSalesChannelId !== null)
  @IsString()
  defaultSalesChannelId?: string | null;
}
