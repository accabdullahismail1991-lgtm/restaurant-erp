import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ApprovalRulesService } from './approval-rules.service';
import { CreateApprovalRuleDto } from './dto/create-approval-rule.dto';

// Configuring the Approval Matrix itself is a separate, more sensitive
// capability than creating or approving a single PO -- gated by its own
// permission (purchasing.manage_rules), held only by مدير النظام in
// prisma/seed.ts. This is the "admin panel" docs/DECISIONS.md #8 refers
// to; there is no hardcoded threshold logic anywhere else in the codebase.
@Controller('approval-rules')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('purchasing.manage_rules')
export class ApprovalRulesController {
  constructor(private readonly approvalRules: ApprovalRulesService) {}

  @Post()
  create(@Body() dto: CreateApprovalRuleDto) {
    return this.approvalRules.create(dto);
  }

  @Get()
  findAll() {
    return this.approvalRules.findAll();
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.approvalRules.delete(id);
  }
}
