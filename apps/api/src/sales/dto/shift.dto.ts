import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class OpenShiftDto {
  @IsString()
  locationId!: string;

  @IsNumber()
  @Min(0)
  openingFloat!: number;

  // Requires pos.backdate_shift (see ShiftsService.open) -- lets a manager
  // open a shift dated on a past business day to record sales that were
  // missed at the time (system down, forgot to open a shift, etc.),
  // instead of that day being lost or force-fit onto today's numbers.
  @IsOptional()
  @IsDateString()
  businessDate?: string;
}

export class CloseShiftDto {
  @IsNumber()
  @Min(0)
  closingCounted!: number;
}

export class CloseDayDto {
  @IsString()
  locationId!: string;

  @IsString()
  businessDate!: string;
}
