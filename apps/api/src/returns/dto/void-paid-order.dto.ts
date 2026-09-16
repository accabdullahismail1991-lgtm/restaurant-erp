import { IsOptional, IsString } from 'class-validator';

export class VoidPaidOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
