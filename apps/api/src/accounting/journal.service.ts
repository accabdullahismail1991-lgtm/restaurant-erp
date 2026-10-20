import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Any Prisma client shape that exposes the models this service touches --
// either the real PrismaService or the `tx` handed to a
// `prisma.$transaction(async (tx) => ...)` callback, same pattern as
// InventoryService.Db -- posting is always a side effect of the SAME
// transaction that already does the real write (an order getting paid, a
// PO getting received), never a separate step that could succeed or fail
// independently of the event it's recording.
type Db = Pick<PrismaService, 'account' | 'journalEntry' | 'journalLine' | 'accountingPeriodClose'>;

export interface JournalLineInput {
  accountCode: string;
  debit?: number;
  credit?: number;
}

export interface PostJournalArgs {
  businessDate: Date;
  sourceType: string;
  sourceId: string;
  locationId?: string;
  description: string;
  createdById: string;
  lines: JournalLineInput[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Phase 0 of the reporting-architecture doc, step 2 (shadow posting): the
// one place every posting rule funnels through, so "every entry balances"
// and "nothing posts into a closed period" are enforced exactly once,
// never re-implemented per caller. Still SHADOW posting -- nothing reads
// from JournalEntry/JournalLine yet (no GL report is exposed), per the
// doc's own rollout plan: this runs silently against real traffic for a
// full period before anything trusts its numbers.
@Injectable()
export class JournalService {
  constructor(private readonly prisma: PrismaService) {}

  async post(db: Db, args: PostJournalArgs) {
    // A zero-value event (e.g. a fully-discounted order, a waste entry for
    // an ingredient with no cost data yet) posts nothing rather than an
    // empty or degenerate entry -- there's nothing to balance.
    const lines = args.lines.filter((l) => round2(l.debit ?? 0) !== 0 || round2(l.credit ?? 0) !== 0);
    if (!lines.length) return null;

    const totalDebit = round2(lines.reduce((s, l) => s + (l.debit ?? 0), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + (l.credit ?? 0), 0));
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      // A bug in the CALLER's posting rule, never a user input error --
      // the amounts a posting rule assembles always come from the same
      // already-validated totals (grandTotal, vatTotal...) the triggering
      // write itself just computed.
      throw new BadRequestException(
        `قيد محاسبي غير متوازن (${args.sourceType}/${args.sourceId}): مدين ${totalDebit} ≠ دائن ${totalCredit}`,
      );
    }

    const closedPeriod = await db.accountingPeriodClose.findFirst({
      where: { periodStart: { lte: args.businessDate }, periodEnd: { gte: args.businessDate }, reopenedAt: null },
    });
    if (closedPeriod) {
      throw new BadRequestException('الفترة المحاسبية لهذا التاريخ مُقفلة -- لا يمكن ترحيل قيد جديد إليها');
    }

    const codes = [...new Set(lines.map((l) => l.accountCode))];
    const accounts = await db.account.findMany({ where: { code: { in: codes } } });
    const accountByCode = new Map(accounts.map((a) => [a.code, a]));
    const missing = codes.filter((c) => !accountByCode.has(c));
    if (missing.length) {
      throw new BadRequestException(`حساب غير موجود في دليل الحسابات: ${missing.join(', ')}`);
    }

    const entry = await db.journalEntry.create({
      data: {
        businessDate: args.businessDate,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        locationId: args.locationId,
        description: args.description,
        createdById: args.createdById,
      },
    });
    await db.journalLine.createMany({
      data: lines.map((l) => ({
        journalEntryId: entry.id,
        accountId: accountByCode.get(l.accountCode)!.id,
        debit: new Prisma.Decimal(round2(l.debit ?? 0)),
        credit: new Prisma.Decimal(round2(l.credit ?? 0)),
      })),
    });
    return entry;
  }
}
