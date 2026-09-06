import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

// documentType is a free string per the schema (room for future document
// types), constrained here to the ones an actual module routes through
// the Approval Matrix: purchase orders (Phase 5) and stocktake variances
// (Phase 4b, docs/ARCHITECTURE.md).
const DOCUMENT_TYPES = ['PURCHASE_ORDER', 'STOCKTAKE_ADJUSTMENT'];

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
