import { IsOptional, IsString, Matches } from 'class-validator';

export class CreateOrderTypeDto {
  @IsString()
  name!: string;

  // Stable identifier stored on every Order.channel / Promotion.channelLimit
  // row created under this type -- uppercase/underscore only (matches the
  // existing DINE_IN/TAKEAWAY/... convention) so it stays a safe,
  // unambiguous value to filter/aggregate on (analytics, shift-close
  // summary), never mixed free text.
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'الكود يجب أن يكون بحروف إنجليزية كبيرة وأرقام و "_" فقط، ويبدأ بحرف' })
  code!: string;

  @IsOptional()
  @IsString()
  icon?: string;
}
