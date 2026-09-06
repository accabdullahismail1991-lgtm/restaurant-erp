import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

// documentType is a free string per the schema (room for future document
// types beyond PURCHASE_ORDER), but purchasing is the only one wired up
// so far -- keep it constrained here until another module needs one.
const DOCUMENT_TYPES = ['PURCHASE_ORDER'];

export class CreateApprovalRuleDto {
  @IsIn(DOCUMENT_TYPES)
  documentType!: string;

  // Omitted/null = no upper limit -- this rule's role is required
  // regardless of amount, once no tighter (lower maxAmount) rule covers
  // it. See ApprovalRulesService for the exact tie-break logic.
  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxAmount?: number;

  @IsString()
  requiredRoleId!: string;

  @IsOptional()
  @IsString()
  scopeLocationId?: string;
}
