import { IsNumber, IsPositive, IsString } from 'class-validator';

export class CreateMenuItemDto {
  @IsString()
  name!: string;

  @IsString()
  category!: string;

  @IsNumber()
  @IsPositive()
  price!: number;
}
