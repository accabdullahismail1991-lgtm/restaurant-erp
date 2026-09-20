import { IsString } from 'class-validator';

export class ConvertUnitDto {
  @IsString()
  toUnit!: string;
}
