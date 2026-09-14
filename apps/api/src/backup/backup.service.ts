import { Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as zlib from 'zlib';
import { PrismaService } from '../prisma/prisma.service';

// Every table in the schema, in strict parent-before-child order (an
// insert in this order never hits a not-yet-inserted foreign key; deleting
// in the REVERSE of this order never hits a still-referencing child row).
// Deliberately excludes the Backup model itself -- a backup is metadata
// ABOUT the system's data, not part of it, so restoring one backup never
// touches/loses any other backup already sitting in the table.
//
// This list was derived by hand from every `@relation(fields: [...])` in
// schema.prisma (see the model-by-model comments there); a few fields that
// LOOK like foreign keys but declare no `@relation` (Table.locationId,
// Supplier.scopeLocationId, ApprovalRule.requiredRoleId/scopeLocationId,
// GeneratedReport.locationId, DailyInvoiceCounter.locationId,
// InventoryBalance.ingredientId) are NOT actual DB constraints, so they
// impose no ordering requirement here.
const MODEL_ORDER = [
  'location',
  'user',
  'role',
  'permission',
  'rolePermission',
  'userRole',
  'userLocationScope',
  'dayClose',
  'unitOfMeasure',
  'ingredient',
  'inventoryBatch',
  'stockMovement',
  'inventoryBalance',
  'salesChannel',
  'menuItem',
  'menuItemChannelPrice',
  'recipeLine',
  'supplier',
  'purchaseOrder',
  'purchaseOrderLine',
  'purchaseReturn',
  'purchaseReturnLine',
  'approvalRule',
  'shift',
  'productionOrder',
  'productionOrderLine',
  'transfer',
  'transferLine',
  'stocktake',
  'stocktakeLine',
  'approval',
  'customer',
  'loyaltyTransaction',
  'table',
  'promotion',
  'order',
  'dailyInvoiceCounter',
  'orderActivityLog',
  'comboMeal',
  'comboSlot',
  'comboSlotOption',
  'orderLine',
  'comboSelection',
  'orderReturn',
  'orderReturnLine',
  'payment',
  'paymentMethod',
  'generatedReport',
] as const;

type ModelName = (typeof MODEL_ORDER)[number];

// Order.sequenceNumber is the schema's only DB-level autoincrement column
// (everything else uses cuid() ids, or a plain Int counter stored ON the
// row itself, like Location.lastShiftNumber -- those come back correct
// automatically as part of the row data). Restoring explicit values via
// createMany bypasses the DEFAULT, so Postgres's underlying sequence is
// left wherever it was BEFORE the restore -- the next real order created
// afterwards could then collide with a restored sequenceNumber. This must
// be fixed up once, after all rows are back in.
const SEQUENCE_FIXUPS: Array<{ table: string; column: string }> = [{ table: 'Order', column: 'sequenceNumber' }];

interface BackupDump {
  version: 1;
  dumpedAt: string;
  models: Partial<Record<ModelName, unknown[]>>;
}

@Injectable()
export class BackupService {
  constructor(private readonly prisma: PrismaService) {}

  // -- serialization helpers -------------------------------------------------
  // Buffer (Bytes columns) is the one type JSON can't represent losslessly
  // on its own; Decimal (decimal.js) and Date both already serialize to a
  // sane string via their own toJSON when JSON.stringify runs, so only
  // Buffer needs a manual pass BEFORE stringifying.
  private static toPlainValue(value: unknown): unknown {
    if (Buffer.isBuffer(value)) return { $type: 'Buffer', base64: value.toString('base64') };
    return value;
  }

  private static toPlainRow(row: Record<string, unknown>): Record<string, unknown> {
    const plain: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) plain[key] = BackupService.toPlainValue(value);
    return plain;
  }

  // Reverses toPlainValue -- walks every row back into the shape Prisma's
  // createMany expects (a real Buffer for Bytes columns; ISO date strings
  // and decimal strings both pass straight through, Prisma accepts both).
  private static fromPlainRow(row: Record<string, unknown>): Record<string, unknown> {
    const restored: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value && typeof value === 'object' && (value as any).$type === 'Buffer' && typeof (value as any).base64 === 'string') {
        restored[key] = Buffer.from((value as any).base64, 'base64');
      } else {
        restored[key] = value;
      }
    }
    return restored;
  }

  // -- dump --------------------------------------------------------------
  private async dumpAllTables(): Promise<BackupDump> {
    const models: Partial<Record<ModelName, unknown[]>> = {};
    for (const name of MODEL_ORDER) {
      const rows: Array<Record<string, unknown>> = await (this.prisma as any)[name].findMany();
      models[name] = rows.map((r) => BackupService.toPlainRow(r));
    }
    return { version: 1, dumpedAt: new Date().toISOString(), models };
  }

  async createBackup(createdBy: string, note?: string) {
    const dump = await this.dumpAllTables();
    const json = JSON.stringify(dump);
    const gzipped = zlib.gzipSync(Buffer.from(json, 'utf-8'));
    const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
    return this.prisma.backup.create({
      data: {
        createdBy,
        note: note ?? null,
        fileName,
        sizeBytes: gzipped.byteLength,
        fileData: gzipped,
      },
      select: { id: true, createdBy: true, note: true, fileName: true, sizeBytes: true, createdAt: true },
    });
  }

  // Runs every night -- see docs/README for why the site has no email/SMS
  // credentials to actually notify anyone of failure; this is a "the file
  // exists and is downloadable from the admin panel the next time someone
  // looks" guarantee, same posture as ReportsService.scheduledDailyGeneration.
  @Cron('0 2 * * *')
  async scheduledDailyBackup() {
    await this.createBackup('SYSTEM_CRON', 'نسخة احتياطية تلقائية يومية');
    await this.pruneOldBackups(14);
  }

  // Keeps only the most recent `keep` rows -- both manual and automatic
  // backups count toward the same limit, since a manual backup taken right
  // before a risky action is exactly the kind of thing worth keeping
  // longest, not pruned first just because it wasn't the nightly one.
  async pruneOldBackups(keep: number) {
    const toKeep = await this.prisma.backup.findMany({
      orderBy: { createdAt: 'desc' },
      take: keep,
      select: { id: true },
    });
    const keepIds = toKeep.map((b) => b.id);
    const deleted = await this.prisma.backup.deleteMany({ where: { id: { notIn: keepIds } } });
    return { pruned: deleted.count };
  }

  async listBackups() {
    return this.prisma.backup.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdBy: true, note: true, fileName: true, sizeBytes: true, createdAt: true },
    });
  }

  async downloadBackup(id: string) {
    const backup = await this.prisma.backup.findUnique({ where: { id } });
    if (!backup) throw new NotFoundException('النسخة الاحتياطية غير موجودة');
    // Decompressed on the way out -- a plain, portable .json a person can
    // open/diff/upload-elsewhere, not a .gz they need tooling to read; the
    // gzip only exists to keep the Postgres bytea column small.
    const json = zlib.gunzipSync(backup.fileData);
    return { buffer: json, fileName: backup.fileName.replace(/\.gz$/, '') };
  }

  // -- restore -------------------------------------------------------------
  private parseDump(raw: Buffer): BackupDump {
    // Auto-detects gzip (magic bytes 1f 8b) so this accepts BOTH a
    // downloaded backup file (gzipped) and a plain .json export -- the
    // exact scenario of hand-carrying a dump from one environment (e.g. a
    // throwaway sandbox with no durable URL) into another's restore
    // endpoint, like the sandbox-to-Render migration this module exists for.
    const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    const json = isGzip ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
    const dump = JSON.parse(json) as BackupDump;
    if (dump?.version !== 1 || typeof dump.models !== 'object') {
      throw new NotFoundException('ملف النسخة الاحتياطية غير صالح أو بصيغة غير مدعومة');
    }
    return dump;
  }

  private async restoreFromDump(dump: BackupDump) {
    const counts: Partial<Record<ModelName, number>> = {};
    await this.prisma.$transaction(
      async (tx) => {
        // Children before parents.
        for (const name of [...MODEL_ORDER].reverse()) {
          await (tx as any)[name].deleteMany({});
        }
        // Parents before children.
        for (const name of MODEL_ORDER) {
          const rows = (dump.models[name] ?? []).map((r) => BackupService.fromPlainRow(r as Record<string, unknown>));
          if (rows.length) await (tx as any)[name].createMany({ data: rows });
          counts[name] = rows.length;
        }
        for (const { table, column } of SEQUENCE_FIXUPS) {
          await tx.$executeRawUnsafe(
            `SELECT setval(pg_get_serial_sequence('"${table}"', '${column}'), COALESCE((SELECT MAX("${column}") FROM "${table}"), 1))`,
          );
        }
      },
      { timeout: 120_000, maxWait: 120_000 },
    );
    return counts;
  }

  async restoreBackup(id: string) {
    const backup = await this.prisma.backup.findUnique({ where: { id } });
    if (!backup) throw new NotFoundException('النسخة الاحتياطية غير موجودة');
    const dump = this.parseDump(backup.fileData as Buffer);
    return this.restoreFromDump(dump);
  }

  async restoreFromUpload(fileBuffer: Buffer) {
    const dump = this.parseDump(fileBuffer);
    return this.restoreFromDump(dump);
  }
}
