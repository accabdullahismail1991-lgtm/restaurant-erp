import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class CreatePaymentMethodDto {
  @IsString()
  name!: string;

  // Stable identifier stored on every Payment.method row created under
  // this method -- uppercase/underscore only (matches the existing
  // CASH/CARD/WALLET convention) so it stays a safe, unambiguous value to
  // filter/aggregate on (ShiftsService.close, analytics), never mixed
  // free text.
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'الكود يجب أن يكون بحروف إنجليزية كبيرة وأرقام و "_" فقط، ويبدأ بحرف' })
  code!: string;

  @IsOptional()
  @IsBoolean()
  isCash?: boolean;
}
