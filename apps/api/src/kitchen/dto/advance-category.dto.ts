import { IsString } from 'class-validator';

export class AdvanceCategoryDto {
  @IsString()
  locationId!: string;

  @IsString()
  category!: string;
}
