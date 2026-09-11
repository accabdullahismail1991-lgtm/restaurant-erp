import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import PDFDocument = require('pdfkit');
import { AnalyticsService } from '../analytics/analytics.service';
import { scopedLocationIds } from '../common/location-scope.util';
import { PrismaService } from '../prisma/prisma.service';

// __dirname sits at apps/api/src/reports when run via ts-node/ts-jest, but
// at apps/api/dist/src/reports once compiled -- one directory level deeper
// -- so both distances up to apps/api are tried. This must not depend on
// process.cwd(): Render's startCommand runs `node apps/api/dist/src/main.js`
// from the repo root, not from apps/api, so a cwd-relative path resolves to
// the wrong place in production even though it happens to work under the
// test runner (which does start with cwd = apps/api).
function resolveArabicFontPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansArabic.ttf'),
    path.join(__dirname, '..', '..', '..', 'assets', 'fonts', 'NotoSansArabic.ttf'),
    path.join(process.cwd(), 'assets', 'fonts', 'NotoSansArabic.ttf'),
    path.join(process.cwd(), 'apps', 'api', 'assets', 'fonts', 'NotoSansArabic.ttf'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

const ARABIC_FONT_PATH = resolveArabicFontPath();

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
  //
  // Odoo/Foodics-style formatting layer below (header fill + white bold
  // text, frozen header row, money columns as #,##0.00, a bold TOTAL row
  // under every table) is pure exceljs styling/number-format metadata --
  // it never re-encodes the Arabic strings themselves, so it carries none
  // of the risk buildPdf()'s comment below describes.
  private styleHeaderRow(row: ExcelJS.Row) {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37309F' } };
    row.alignment = { horizontal: 'right' };
  }
  private styleTotalRow(row: ExcelJS.Row) {
    row.font = { bold: true };
    row.border = { top: { style: 'medium', color: { argb: 'FF37309F' } } };
  }
  private async buildXlsx(data: DailyReportData): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Restaurant ERP';
    wb.created = new Date();
    const moneyFmt = '#,##0.00';

    const summary = wb.addWorksheet('ملخص المبيعات', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 4 }] });
    summary.columns = [{ width: 26 }, { width: 20 }, { width: 20 }];
    summary.addRow(['الموقع', data.locationName]).font = { bold: true };
    summary.addRow(['الفترة', `${data.periodStart.toISOString().slice(0, 10)} → ${data.periodEnd.toISOString().slice(0, 10)}`]);
    summary.addRow(['أُنشئ في', new Date().toLocaleString('ar-SA')]);
    this.styleHeaderRow(summary.addRow(['المؤشر', 'القيمة']));
    summary.addRow(['عدد الطلبات', data.salesSummary.orderCount]);
    summary.addRow(['الإيراد', data.salesSummary.revenue]).getCell(2).numFmt = moneyFmt;
    summary.addRow(['صافي المبيعات', data.salesSummary.netSales]).getCell(2).numFmt = moneyFmt;
    summary.addRow(['ضريبة القيمة المضافة', data.salesSummary.vatCollected]).getCell(2).numFmt = moneyFmt;
    summary.addRow(['الخصومات', data.salesSummary.discountGiven]).getCell(2).numFmt = moneyFmt;
    summary.addRow(['متوسط قيمة الطلب', data.salesSummary.averageOrderValue]).getCell(2).numFmt = moneyFmt;
    summary.addRow([]);
    this.styleHeaderRow(summary.addRow(['القناة', 'عدد الطلبات', 'الإيراد']));
    for (const c of data.salesSummary.byChannel) summary.addRow([c.channel, c.orderCount, c.revenue]).getCell(3).numFmt = moneyFmt;
    const channelTotalRow = summary.addRow([
      'الإجمالي',
      data.salesSummary.byChannel.reduce((s, c) => s + c.orderCount, 0),
      data.salesSummary.byChannel.reduce((s, c) => s + c.revenue, 0),
    ]);
    this.styleTotalRow(channelTotalRow);
    channelTotalRow.getCell(3).numFmt = moneyFmt;

    const items = wb.addWorksheet('الأصناف الأكثر مبيعًا', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    items.columns = [{ width: 30 }, { width: 12 }, { width: 14 }];
    this.styleHeaderRow(items.addRow(['الصنف', 'الكمية', 'الإيراد']));
    for (const i of data.topItems) items.addRow([i.name, i.quantity, i.revenue]).getCell(3).numFmt = moneyFmt;
    if (data.topItems.length) {
      const itemsTotalRow = items.addRow([
        'الإجمالي',
        data.topItems.reduce((s, i) => s + i.quantity, 0),
        data.topItems.reduce((s, i) => s + i.revenue, 0),
      ]);
      this.styleTotalRow(itemsTotalRow);
      itemsTotalRow.getCell(3).numFmt = moneyFmt;
    }

    const foodCost = wb.addWorksheet('تكلفة الطعام', { views: [{ rightToLeft: true }] });
    foodCost.columns = [{ width: 26 }, { width: 16 }];
    this.styleHeaderRow(foodCost.addRow(['المؤشر', 'القيمة']));
    foodCost.addRow(['صافي المبيعات', data.foodCost.netSales]).getCell(2).numFmt = moneyFmt;
    foodCost.addRow(['تكلفة البضاعة المباعة', data.foodCost.cogs]).getCell(2).numFmt = moneyFmt;
    foodCost.addRow(['هامش الربح', data.foodCost.grossMargin]).getCell(2).numFmt = moneyFmt;
    foodCost.addRow(['نسبة تكلفة الطعام %', data.foodCost.foodCostPercent]).getCell(2).numFmt = '0.0"%"';
    foodCost.addRow(['نسبة هامش الربح %', data.foodCost.grossMarginPercent]).getCell(2).numFmt = '0.0"%"';

    const lowStock = wb.addWorksheet('نقص المخزون', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    lowStock.columns = [{ width: 26 }, { width: 20 }, { width: 14 }, { width: 14 }];
    this.styleHeaderRow(lowStock.addRow(['الخامة', 'الموقع', 'الكمية الحالية', 'الحد الأدنى']));
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
  // Section dividers/boxes/footer below are pdfkit vector primitives
  // (.rect/.moveTo/.lineTo) -- they carry none of the Arabic-shaping risk
  // the comment above describes, so this is safe ground to make the
  // layout read like a real report (Odoo/Foodics-style header band +
  // ruled sections + footer) without touching how any text is drawn.
  private pdfSectionHeading(doc: PDFKit.PDFDocument, title: string) {
    const x = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.moveDown(0.5);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#37309F').text(title, x, y);
    doc.moveTo(x, doc.y + 2).lineTo(x + width, doc.y + 2).lineWidth(1).strokeColor('#37309F').stroke();
    doc.fillColor('#000000');
    doc.moveDown(0.4);
  }
  private buildPdf(data: DailyReportData): Promise<Buffer> {
    const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, bufferPages: true });
      doc.registerFont('arabic', ARABIC_FONT_PATH);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header band: a filled bar with the report title, same accent color
      // the admin panel's own reports use (var(--brand): #37309F).
      const bandHeight = 56;
      doc.rect(0, 0, doc.page.width, bandHeight).fill('#37309F');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18).text('Daily Report', doc.page.margins.left, 16);
      doc.font('arabic').fontSize(11).text(data.locationName, doc.page.margins.left, 38);
      doc.fillColor('#000000').y = bandHeight + 16;
      doc.font('Helvetica').fontSize(10).fillColor('#555555')
        .text(`Period: ${data.periodStart.toISOString().slice(0, 10)} - ${data.periodEnd.toISOString().slice(0, 10)}    |    Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      doc.fillColor('#000000');

      this.pdfSectionHeading(doc, 'Sales Summary');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Orders: ${data.salesSummary.orderCount}`);
      doc.text(`Revenue: ${fmt(data.salesSummary.revenue)} SAR`);
      doc.text(`Net sales: ${fmt(data.salesSummary.netSales)} SAR`);
      doc.text(`VAT collected: ${fmt(data.salesSummary.vatCollected)} SAR`);
      doc.text(`Discounts given: ${fmt(data.salesSummary.discountGiven)} SAR`);
      doc.font('Helvetica-Bold').text(`Average order value: ${fmt(data.salesSummary.averageOrderValue)} SAR`);

      this.pdfSectionHeading(doc, 'Top Items');
      doc.font('Helvetica').fontSize(10);
      for (const i of data.topItems) {
        doc.font('arabic').text(`${i.name}: `, { continued: true });
        doc.font('Helvetica').text(`qty ${i.quantity}, revenue ${fmt(i.revenue)} SAR`);
      }
      if (!data.topItems.length) doc.text('No sales in this period.');

      this.pdfSectionHeading(doc, 'Food Cost');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Net sales: ${fmt(data.foodCost.netSales)} SAR`);
      doc.text(`COGS: ${fmt(data.foodCost.cogs)} SAR`);
      doc.text(`Gross margin: ${fmt(data.foodCost.grossMargin)} SAR (${data.foodCost.grossMarginPercent.toFixed(1)}%)`);
      doc.text(`Food cost: ${data.foodCost.foodCostPercent.toFixed(1)}%`);

      this.pdfSectionHeading(doc, 'Low Stock Alerts');
      doc.font('Helvetica').fontSize(10);
      for (const r of data.lowStock) {
        doc.font('arabic').text(`${r.name} (${r.locationName}): `, { continued: true });
        doc.font('Helvetica').text(`${r.quantity} / min ${r.lowStockThreshold}`);
      }
      if (!data.lowStock.length) doc.text('Nothing below threshold.');

      // Footer on every page: page number, added last (bufferPages: true
      // lets pdfkit report the final page count only once generation is done).
      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(8).fillColor('#888888')
          .text(`Page ${i + 1} of ${pageCount}`, doc.page.margins.left, doc.page.height - 30, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            align: 'center',
          });
      }

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
