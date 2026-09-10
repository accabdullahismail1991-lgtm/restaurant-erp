import { IsString, MinLength } from 'class-validator';

export class CreateSalesChannelDto {
  @IsString()
  @MinLength(1)
  name!: string;
}
