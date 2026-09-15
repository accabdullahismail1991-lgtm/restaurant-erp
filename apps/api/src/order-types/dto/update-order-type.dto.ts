import { IsBoolean, IsOptional, IsString } from 'class-validator';

// `code` is deliberately NOT editable here -- it's already stamped onto
// every historical Order.channel/Promotion.channelLimit row created under
// this type, so renaming it would silently orphan past orders from future
// filters/reports. Deactivate and create a new type instead if the code
// itself is wrong.
export class UpdateOrderTypeDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
