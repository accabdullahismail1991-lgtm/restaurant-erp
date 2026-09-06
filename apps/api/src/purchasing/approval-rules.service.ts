import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateApprovalRuleDto } from './dto/create-approval-rule.dto';

@Injectable()
export class ApprovalRulesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateApprovalRuleDto) {
    return this.prisma.approvalRule.create({ data: dto });
  }

  findAll() {
    return this.prisma.approvalRule.findMany({ orderBy: [{ documentType: 'asc' }, { maxAmount: 'asc' }] });
  }

  async delete(id: string) {
    const rule = await this.prisma.approvalRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('القاعدة غير موجودة');
    await this.prisma.approvalRule.delete({ where: { id } });
    return { id };
  }

  // Picks the ONE rule that governs a document of `amount` for
  // `locationId`, per docs/DECISIONS.md #8 (an admin-configured table, not
  // if/else in the PO code). Tie-break: a location-specific rule always
  // wins over an org-wide one (scopeLocationId null); within a tier, the
  // tightest threshold that still covers the amount applies (e.g. a
  // 5,000 SAR rule and a 20,000 SAR rule both existing for the same
  // scope -- a 3,000 SAR PO is governed by the 5,000 one, not the
  // 20,000 one). A no-limit rule (maxAmount null) applies only if no
  // finite threshold covers it; if the amount exceeds EVERY finite
  // threshold in a tier and there's no no-limit rule either, it falls
  // back to that tier's highest (strictest) rule -- blowing past every
  // configured limit must still require at least the most senior
  // configured approver, never silently auto-approve. Only a tier with NO
  // rules at all (no matching row for this documentType/scope) means no
  // approval gate is configured, so the caller should treat it as
  // auto-approved.
  async findApplicableRule(documentType: string, locationId: string, amount: number) {
    const rules = await this.prisma.approvalRule.findMany({
      where: { documentType, OR: [{ scopeLocationId: null }, { scopeLocationId: locationId }] },
    });
    const tiers = [rules.filter((r) => r.scopeLocationId === locationId), rules.filter((r) => r.scopeLocationId === null)];
    for (const tier of tiers) {
      if (!tier.length) continue;
      const catchAll = tier.find((r) => r.maxAmount === null);
      const finite = tier.filter((r) => r.maxAmount !== null).sort((a, b) => Number(a.maxAmount) - Number(b.maxAmount));
      const covering = finite.find((r) => Number(r.maxAmount) >= amount);
      if (covering) return covering;
      if (catchAll) return catchAll;
      if (finite.length) return finite[finite.length - 1];
    }
    return null;
  }
}
