import { IsInt, IsPositive } from 'class-validator';

export class RedeemPointsDto {
  @IsInt()
  @IsPositive()
  points!: number;
}
