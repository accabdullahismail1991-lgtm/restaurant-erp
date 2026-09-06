import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

export class GenerateReportDto {
  @IsOptional()
  @IsString()
  locationId?: string;

  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  @IsIn(['XLSX', 'PDF', 'BOTH'])
  format!: 'XLSX' | 'PDF' | 'BOTH';
}
