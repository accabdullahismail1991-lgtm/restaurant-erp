import { IsOptional, IsString } from 'class-validator';

export class ApprovalDecisionDto {
  @IsOptional()
  @IsString()
  note?: string;
}
