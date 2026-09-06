import { IsNumber, IsString, Min } from 'class-validator';

export class OpenShiftDto {
  @IsString()
  locationId!: string;

  @IsNumber()
  @Min(0)
  openingFloat!: number;
}

export class CloseShiftDto {
  @IsNumber()
  @Min(0)
  closingCounted!: number;
}
