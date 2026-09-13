import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
