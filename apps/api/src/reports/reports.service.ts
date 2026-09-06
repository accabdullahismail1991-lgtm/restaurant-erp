import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import PDFDocument = require('pdfkit');
import { AnalyticsService } from '../analytics/analytics.service';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';

const ARABIC_FONT_PATH = path.join(process.cwd(), 'assets', 'fonts', 'NotoSansArabic.ttf');

interface DailyReportData {
  locationId: string | null;
  locationName: string;
  periodStart: Date;
  periodEnd: Date;
  salesSummary: Awaited<ReturnType<AnalyticsService['salesSummaryForLocation']>>;
  topItems: Awaited<ReturnType<AnalyticsService['topItemsForLocation']>>;
  foodCost: Awaited<ReturnType<AnalyticsService['foodCostForLocation']>>;
  lowStock: Awaited<ReturnType<AnalyticsService['lowStockForLocation']>>;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  // Every report is assembled through the *ForLocation methods -- they take
  // an already-resolved (or absent) locationId directly and never touch
  // any user's scope, so this same assembly works identically whether it
  // was reached via a scope-checked user request or the unrestricted
  // system cron job below.
  private async assembleData(locationId: string | undefined, from: string, to: string): Promise<DailyReportData> {
    const [salesSummary, topItems, foodCost, lowStock] = await Promise.all([
      this.analytics.salesSummaryForLocation(locationId, from, to),
      this.analytics.topItemsForLocation(locationId, from, to, 20),
      this.analytics.foodCostForLocation(locationId, from, to),
      this.analytics.lowStockForLocation(locationId),
    ]);
    const locationName = locationId
      ? ((await this.prisma.location.findUnique({ where: { id: locationId } }))?.name ?? locationId)
      : 'كل المواقع';
    const { gte, lte } = this.analytics.parseRange(from, to);
    return { locationId: locationId ?? null, locationName, periodStart: gte ?? new Date(0), periodEnd: lte ?? new Date(), salesSummary, topItems, foodCost, lowStock };
  }

  // Excel is the fully Arabic-correct format -- exceljs just writes UTF-8
  // strings into cells, and Excel (or any real spreadsheet app) does its
  // own text shaping/BiDi rendering. No caveats here.
  private async buildXlsx(data: DailyReportData): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Restaurant ERP';
    wb.created = new Date();

    const summary = wb.addWorksheet('ملخص المبيعات');
    summary.columns = [{ width: 26 }, { width: 20 }];
    summary.addRow(['الموقع', data.locationName]);
    summary.addRow(['الفترة', `${data.periodStart.toISOString().slice(0, 10)} → ${data.periodEnd.toISOString().slice(0, 10)}`]);
    summary.addRow([]);
    summary.addRow(['المؤشر', 'القيمة']).font = { bold: true };
    summary.addRow(['عدد الطلبات', data.salesSummary.orderCount]);
    summary.addRow(['الإيراد', data.salesSummary.revenue]);
    summary.addRow(['صافي المبيعات', data.salesSummary.netSales]);
    summary.addRow(['ضريبة القيمة المضافة', data.salesSummary.vatCollected]);
    summary.addRow(['الخصومات', data.salesSummary.discountGiven]);
    summary.addRow(['متوسط قيمة الطلب', data.salesSummary.averageOrderValue]);
    summary.addRow([]);
    summary.addRow(['القناة', 'عدد الطلبات', 'الإيراد']).font = { bold: true };
    for (const c of data.salesSummary.byChannel) summary.addRow([c.channel, c.orderCount, c.revenue]);

    const items = wb.addWorksheet('الأصناف الأكثر مبيعًا');
    items.columns = [{ width: 30 }, { width: 12 }, { width: 14 }];
    items.addRow(['الصنف', 'الكمية', 'الإيراد']).font = { bold: true };
    for (const i of data.topItems) items.addRow([i.name, i.quantity, i.revenue]);

    const foodCost = wb.addWorksheet('تكلفة الطعام');
    foodCost.columns = [{ width: 26 }, { width: 16 }];
    foodCost.addRow(['المؤشر', 'القيمة']).font = { bold: true };
    foodCost.addRow(['صافي المبيعات', data.foodCost.netSales]);
    foodCost.addRow(['تكلفة البضاعة المباعة', data.foodCost.cogs]);
    foodCost.addRow(['هامش الربح', data.foodCost.grossMargin]);
    foodCost.addRow(['نسبة تكلفة الطعام %', data.foodCost.foodCostPercent]);
    foodCost.addRow(['نسبة هامش الربح %', data.foodCost.grossMarginPercent]);

    const lowStock = wb.addWorksheet('نقص المخزون');
    lowStock.columns = [{ width: 26 }, { width: 20 }, { width: 14 }, { width: 14 }];
    lowStock.addRow(['الخامة', 'الموقع', 'الكمية الحالية', 'الحد الأدنى']).font = { bold: true };
    for (const r of data.lowStock) lowStock.addRow([r.name, r.locationName, r.quantity, r.lowStockThreshold]);

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // pdfkit does not perform Arabic contextual letter-shaping or BiDi
  // reordering -- it draws whatever Unicode codepoints it's given as
  // isolated glyphs in left-to-right order, and this sandboxed environment
  // has no PDF-rendering/screenshot tool available to visually verify a
  // reshape+reverse workaround. Rather than ship an unverified fix that
  // might silently render garbled text, structural labels here are
  // deliberately English; real Arabic proper-noun DATA (location/item
  // names) is still included as literal text via the embedded Arabic font
  // (so it at least renders as recognizable glyphs rather than blank
  // boxes), with this same caveat about letter joining. The Excel export
  // above is the fully Arabic-correct format for real use.
  private buildPdf(data: DailyReportData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      doc.registerFont('arabic', ARABIC_FONT_PATH);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(18).text('Daily Report', { align: 'left' });
      doc.font('arabic').fontSize(11).text(data.locationName, { align: 'left' });
      doc.font('Helvetica').fontSize(10).text(`Period: ${data.periodStart.toISOString().slice(0, 10)} - ${data.periodEnd.toISOString().slice(0, 10)}`);
      doc.moveDown();

      doc.font('Helvetica-Bold').fontSize(14).text('Sales Summary');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Orders: ${data.salesSummary.orderCount}`);
      doc.text(`Revenue: ${data.salesSummary.revenue.toFixed(2)} SAR`);
      doc.text(`Net sales: ${data.salesSummary.netSales.toFixed(2)} SAR`);
      doc.text(`VAT collected: ${data.salesSummary.vatCollected.toFixed(2)} SAR`);
      doc.text(`Discounts given: ${data.salesSummary.discountGiven.toFixed(2)} SAR`);
      doc.text(`Average order value: ${data.salesSummary.averageOrderValue.toFixed(2)} SAR`);
      doc.moveDown();

      doc.font('Helvetica-Bold').fontSize(14).text('Top Items');
      doc.font('Helvetica').fontSize(10);
      for (const i of data.topItems) {
        doc.font('arabic').text(`${i.name}: `, { continued: true });
        doc.font('Helvetica').text(`qty ${i.quantity}, revenue ${i.revenue.toFixed(2)} SAR`);
      }
      if (!data.topItems.length) doc.text('No sales in this period.');
      doc.moveDown();

      doc.font('Helvetica-Bold').fontSize(14).text('Food Cost');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Net sales: ${data.foodCost.netSales.toFixed(2)} SAR`);
      doc.text(`COGS: ${data.foodCost.cogs.toFixed(2)} SAR`);
      doc.text(`Gross margin: ${data.foodCost.grossMargin.toFixed(2)} SAR (${data.foodCost.grossMarginPercent.toFixed(1)}%)`);
      doc.text(`Food cost: ${data.foodCost.foodCostPercent.toFixed(1)}%`);
      doc.moveDown();

      doc.font('Helvetica-Bold').fontSize(14).text('Low Stock Alerts');
      doc.font('Helvetica').fontSize(10);
      for (const r of data.lowStock) {
        doc.font('arabic').text(`${r.name} (${r.locationName}): `, { continued: true });
        doc.font('Helvetica').text(`${r.quantity} / min ${r.lowStockThreshold}`);
      }
      if (!data.lowStock.length) doc.text('Nothing below threshold.');

      doc.end();
    });
  }

  private async assertLocationInScope(userId: string, locationId: string): Promise<void> {
    const allowed = await scopedLocationIds(this.prisma, userId);
    if (allowed && !allowed.includes(locationId)) throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
  }

  async generateNow(userId: string, locationId: string | undefined, from: string, to: string, format: 'XLSX' | 'PDF' | 'BOTH') {
    if (!from || !to) throw new BadRequestException('يجب تحديد from وto');
    if (locationId) await this.assertLocationInScope(userId, locationId);

    const data = await this.assembleData(locationId, from, to);
    return this.renderAndPersist(data, format);
  }

  private async renderAndPersist(data: DailyReportData, format: 'XLSX' | 'PDF' | 'BOTH') {
    const periodLabel = data.periodStart.toISOString().slice(0, 10);
    const created: { id: string; format: string; fileName: string }[] = [];
    const formats: Array<'XLSX' | 'PDF'> = format === 'BOTH' ? ['XLSX', 'PDF'] : [format];

    for (const fmt of formats) {
      const buffer = fmt === 'XLSX' ? await this.buildXlsx(data) : await this.buildPdf(data);
      const row = await this.prisma.generatedReport.create({
        data: {
          type: 'DAILY_BUNDLE',
          format: fmt,
          locationId: data.locationId,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
          fileName: `daily-report_${data.locationId ?? 'all'}_${periodLabel}.${fmt.toLowerCase()}`,
          fileData: buffer,
        },
      });
      created.push({ id: row.id, format: row.format, fileName: row.fileName });
    }
    return created;
  }

  async list(userId: string, locationId?: string) {
    const allowed = await scopedLocationIds(this.prisma, userId);
    if (locationId && allowed && !allowed.includes(locationId)) throw new ForbiddenException('الموقع خارج نطاق صلاحيتك');
    const ids = locationId ? [locationId] : (allowed ?? undefined);
    return this.prisma.generatedReport.findMany({
      where: { locationId: ids ? { in: ids } : undefined },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, format: true, locationId: true, periodStart: true, periodEnd: true, fileName: true, createdAt: true },
    });
  }

  async download(userId: string, id: string) {
    const report = await this.prisma.generatedReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('التقرير غير موجود');
    if (report.locationId) await this.assertLocationInScope(userId, report.locationId);
    return report;
  }

  // The real "scheduled reports" deliverable: runs automatically every
  // day, generating yesterday's bundle for every active location plus one
  // org-wide bundle, in both formats -- persisted rows the admin panel's
  // Reports tab lists and can download. "Scheduled" here means "generated
  // automatically and made available to download from the system", not
  // "emailed": there are no SMTP/email-provider credentials available in
  // this environment (the same class of external-credential gap as
  // ZATCA's real platform submission), so email delivery is out of scope
  // until real credentials exist.
  @Cron('0 1 * * *')
  async scheduledDailyGeneration() {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const periodStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()));
    const periodEnd = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 23, 59, 59, 999));
    await this.generateForAllLocations(periodStart.toISOString(), periodEnd.toISOString());
  }

  // Split out from the @Cron handler so tests (and a manual "run for all
  // locations now" admin action) can trigger the exact same real
  // generation logic without waiting for the clock. This is a system-level
  // operation with no per-user scope -- it never borrows any user's
  // location scope (see AnalyticsService's *ForLocation methods).
  async generateForAllLocations(from: string, to: string) {
    const locations = await this.prisma.location.findMany({ where: { isActive: true }, select: { id: true } });
    const results: Array<{ id: string; format: string; fileName: string }> = [];
    for (const locationId of [undefined, ...locations.map((l) => l.id)]) {
      const data = await this.assembleData(locationId, from, to);
      results.push(...(await this.renderAndPersist(data, 'BOTH')));
    }
    return results;
  }
}
