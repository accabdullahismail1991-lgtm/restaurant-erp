import { IsNumber, IsPositive } from 'class-validator';

export class SetChannelPriceDto {
  @IsNumber()
  @IsPositive()
  price!: number;
}
