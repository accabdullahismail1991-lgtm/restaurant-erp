import { IsBoolean, IsOptional, IsString } from 'class-validator';

// `code` is deliberately NOT editable here -- it's already stamped onto
// every historical Payment row created under this method, so renaming it
// would silently orphan past payments from future aggregations/reports.
// Deactivate and create a new method instead if the code itself is wrong.
export class UpdatePaymentMethodDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isCash?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
