import { plainToInstance } from 'class-transformer';
import { IsArray, validate } from 'class-validator';

// Generic body shape for every "<module>/bulk-import" endpoint -- `rows` is
// intentionally untyped here (no @ValidateNested/@Type) so the global
// ValidationPipe's whitelist/forbidNonWhitelisted only checks that `rows`
// itself is an array and leaves each row's own fields untouched; those are
// validated per-row below against the module's own CreateXDto so one bad
// row can be reported and skipped instead of 400-ing the whole batch.
export class BulkImportBodyDto {
  @IsArray()
  rows!: Record<string, unknown>[];
}

export interface BulkImportRowError {
  row: number;
  message: string;
}

export interface BulkImportResult {
  successCount: number;
  errorCount: number;
  errors: BulkImportRowError[];
}

export async function bulkImportRows<T extends object>(
  DtoClass: new () => T,
  rows: unknown[],
  createFn: (dto: T) => Promise<unknown>,
): Promise<BulkImportResult> {
  const errors: BulkImportRowError[] = [];
  let successCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (typeof raw !== 'object' || raw === null) {
      errors.push({ row: i + 1, message: 'صف غير صالح' });
      continue;
    }
    const dto = plainToInstance(DtoClass, raw, { enableImplicitConversion: true });
    const violations = await validate(dto as object, { whitelist: true });
    if (violations.length) {
      const message = violations.map((v) => Object.values(v.constraints || {}).join('، ')).join('؛ ');
      errors.push({ row: i + 1, message: message || 'بيانات غير صالحة' });
      continue;
    }
    try {
      await createFn(dto);
      successCount++;
    } catch (e) {
      errors.push({ row: i + 1, message: e instanceof Error ? e.message : 'خطأ غير متوقع' });
    }
  }

  return { successCount, errorCount: errors.length, errors };
}
