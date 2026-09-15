import { Injectable, BadRequestException, ForbiddenException, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as ExcelJS from 'exceljs';
import { AnalyticsService } from '../analytics/analytics.service';
import { scopedLocationIds } from '../common/location-scope.util';
import { OrderTypesService } from '../order-types/order-types.service';
import { PrismaService } from '../prisma/prisma.service';
import { arabicFontFaceCss, barChartConfig, dataTable, doughnutChartConfig, fmtMoney, lineChartConfig, reportShell, sectionHeading, statTile } from './report-html.util';
import { closeReportBrowser, renderHtmlToPdf } from './pdf-render.util';

// Plain 'ar-SA' silently switches to the Hijri calendar with Eastern
// Arabic-Indic numerals -- inconsistent with the Gregorian dates this
// system actually stores and exports everywhere else (periodStart/End
// above use toISOString() directly). This keeps the exported workbook's
// "generated at" stamp in Arabic but on the Gregorian calendar with
// Western digits, matching admin_panel.html's fmtDateTime.
function fmtGeneratedAt(): string {
  return new Date().toLocaleString('ar-SA-u-ca-gregory-nu-latn');
}

// The same per-module dashboards the admin panel renders as charts
// (Sales/Production/Purchasing/Items/Inventory) -- these labels mirror the
// ones the frontend already uses for the exact same codes, so the exported
// file reads the same as the on-screen chart it came from.
export type DashboardKind = 'sales' | 'production' | 'purchasing' | 'items' | 'inventory';
const DASH_PAYMENT_METHOD_LABEL: Record<string, string> = { CASH: 'كاش', CARD: 'بطاقة', WALLET: 'محفظة إلكترونية' };
const DASH_PO_STATUS_LABEL: Record<string, string> = { DRAFT: 'مسودة', PENDING_APPROVAL: 'بانتظار الاعتماد', APPROVED: 'معتمد', SENT_TO_SUPPLIER: 'مُرسل للمورد', RECEIVED: 'مُستلم', REJECTED: 'مرفوض', CANCELLED: 'ملغى' };
const DASH_PRODUCTION_STATUS_LABEL: Record<string, string> = { PLANNED: 'مخطط', IN_PROGRESS: 'قيد التنفيذ', COMPLETED: 'مكتمل', CANCELLED: 'ملغى' };
const DASH_MENU_ENG_LABEL: Record<string, string> = { STAR: 'نجم', PLOWHORSE: 'حصان عمل', PUZZLE: 'لغز', DOG: 'ضعيف' };

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
export class ReportsService implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly orderTypes: OrderTypesService,
  ) {}

  // Closes the shared headless-Chromium instance PDF exports render
  // through (pdf-render.util.ts) -- see that file's closeReportBrowser()
  // comment for why this matters most under the e2e test runner.
  async onModuleDestroy() {
    await closeReportBrowser();
  }

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
    summary.addRow(['أُنشئ في', fmtGeneratedAt()]);
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

  // Renders through a real headless-Chromium page (report-html.util.ts +
  // pdf-render.util.ts) instead of drawing PDF primitives by hand -- see
  // those files' comments for why. Arabic labels here deliberately match
  // the XLSX export's above (same worksheet names/terms), so the two
  // formats -- and the on-screen reports they summarize -- all read the
  // same. A small chart (top items by revenue) is included for the same
  // "looks like a real report, not a text dump" reason the header
  // band/stat tiles are.
  private async buildPdf(data: DailyReportData): Promise<Buffer> {
    const topItemsForChart = data.topItems.slice(0, 10);
    const html = reportShell({
      title: 'التقرير اليومي',
      subtitle: data.locationName,
      periodLabel: `الفترة: ${data.periodStart.toISOString().slice(0, 10)} → ${data.periodEnd.toISOString().slice(0, 10)}`,
      charts: topItemsForChart.length
        ? [{ canvasId: 'topItemsChart', title: 'الأصناف الأكثر مبيعًا (الإيراد)', config: barChartConfig(topItemsForChart.map((i) => i.name), topItemsForChart.map((i) => i.revenue), 'الإيراد', true) }]
        : [],
      bodyHtml: `
        ${sectionHeading('ملخص المبيعات')}
        <div class="stats-row">
          ${statTile('عدد الطلبات', data.salesSummary.orderCount)}
          ${statTile('الإيراد', fmtMoney(data.salesSummary.revenue))}
          ${statTile('صافي المبيعات', fmtMoney(data.salesSummary.netSales))}
          ${statTile('ضريبة القيمة المضافة', fmtMoney(data.salesSummary.vatCollected))}
          ${statTile('الخصومات', fmtMoney(data.salesSummary.discountGiven))}
          ${statTile('متوسط قيمة الطلب', fmtMoney(data.salesSummary.averageOrderValue))}
        </div>

        ${sectionHeading('الأصناف الأكثر مبيعًا')}
        ${dataTable(['الصنف', 'الكمية', 'الإيراد'], data.topItems.map((i) => [i.name, i.quantity, fmtMoney(i.revenue)]), 'لا توجد مبيعات في هذه الفترة')}

        ${sectionHeading('تكلفة الطعام')}
        <div class="stats-row">
          ${statTile('صافي المبيعات', fmtMoney(data.foodCost.netSales))}
          ${statTile('تكلفة البضاعة المباعة', fmtMoney(data.foodCost.cogs))}
          ${statTile('هامش الربح', fmtMoney(data.foodCost.grossMargin))}
          ${statTile('نسبة تكلفة الطعام', data.foodCost.foodCostPercent.toFixed(1) + '%')}
          ${statTile('نسبة هامش الربح', data.foodCost.grossMarginPercent.toFixed(1) + '%')}
        </div>

        ${sectionHeading('تنبيهات نقص المخزون')}
        ${dataTable(['الخامة', 'الموقع', 'الكمية الحالية', 'الحد الأدنى'], data.lowStock.map((r) => [r.name, r.locationName, r.quantity, r.lowStockThreshold]), 'لا توجد أصناف أقل من الحد الأدنى')}
      `,
    });
    return renderHtmlToPdf(html);
  }

  // Every OTHER report screen (sales log, top customers, tax, peak hours,
  // the standard-report suite, kitchen performance, customer experience,
  // shift/day-close reports...) doesn't get its own hand-built HTML
  // template like buildPdf/buildDashboardPdf above -- there's no reason
  // to, since the admin panel's own screen already IS a correctly
  // formatted, correctly labeled render of that exact data. This takes
  // whatever HTML+CSS that screen already produced (title, the same
  // <style> block the page itself uses, and the populated .view-card
  // with any Chart.js <canvas> already swapped for a static <img> client-
  // side, since a canvas carries no content once serialized) and renders
  // it through the same headless-Chromium pipeline -- guaranteed to match
  // the screen exactly, including whichever language it happened to be
  // showing, because it IS that screen, not a reconstruction of it.
  async renderSnapshotPdf(css: string, bodyHtml: string): Promise<Buffer> {
    // No Chart.js construction happens here (charts already arrived as
    // static <img> data URIs baked into bodyHtml), so the ready flag
    // renderHtmlToPdf waits on is set immediately rather than waiting out
    // its full timeout for a signal that would otherwise never come.
    const html = `<!doctype html>
<html dir="rtl" lang="ar">
<head><meta charset="utf-8"><style>${arabicFontFaceCss()}${css}</style></head>
<body>${bodyHtml}<script>window.__reportReady = true;</script></body>
</html>`;
    return renderHtmlToPdf(html);
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

  // On-demand export of one of the admin panel's chart dashboards as a real
  // file -- unlike generateNow()'s DAILY_BUNDLE (persisted, listed,
  // downloaded later), this is generated and streamed straight back to the
  // request; there's no reason to keep an ad-hoc "export what I'm looking
  // at right now" click around as a row someone has to come back for.
  // Goes through the SAME userId-scoped AnalyticsService methods the
  // on-screen dashboard itself calls (not the cron job's *ForLocation
  // bypass), so a branch-scoped user can only ever export their own scope
  // here too.
  async buildDashboardExport(
    userId: string,
    kind: DashboardKind,
    format: 'XLSX' | 'PDF',
    locationId?: string,
    from?: string,
    to?: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    if (locationId) await this.assertLocationInScope(userId, locationId);
    const locationName = locationId
      ? ((await this.prisma.location.findUnique({ where: { id: locationId } }))?.name ?? locationId)
      : 'كل المواقع';
    const buffer =
      format === 'XLSX'
        ? await this.buildDashboardXlsx(kind, locationName, userId, locationId, from, to)
        : await this.buildDashboardPdf(kind, locationName, userId, locationId, from, to);
    const fileName = `dashboard-${kind}_${locationId ?? 'all'}_${new Date().toISOString().slice(0, 10)}.${format.toLowerCase()}`;
    return { buffer, fileName };
  }

  private async buildDashboardXlsx(
    kind: DashboardKind,
    locationName: string,
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Restaurant ERP';
    wb.created = new Date();
    const moneyFmt = '#,##0.00';
    const rtl = { views: [{ rightToLeft: true, state: 'frozen' as const, ySplit: 1 }] };

    const summary = wb.addWorksheet('ملخص', { views: [{ rightToLeft: true }] });
    summary.columns = [{ width: 26 }, { width: 20 }];
    summary.addRow(['الموقع', locationName]).font = { bold: true };
    if (from || to) summary.addRow(['الفترة', `${from ?? '...'} → ${to ?? '...'}`]);
    summary.addRow(['أُنشئ في', fmtGeneratedAt()]);

    const addKpiRows = (rows: [string, number | string, boolean?][]) => {
      summary.addRow([]);
      this.styleHeaderRow(summary.addRow(['المؤشر', 'القيمة']));
      for (const [label, value, isMoney] of rows) {
        const row = summary.addRow([label, value]);
        if (isMoney) row.getCell(2).numFmt = moneyFmt;
      }
    };
    const addTableSheet = (title: string, headers: string[], rows: (string | number)[][], moneyCols: number[] = [], totalRow?: (string | number)[]) => {
      const sheet = wb.addWorksheet(title.slice(0, 31), rtl);
      sheet.columns = headers.map(() => ({ width: 22 }));
      this.styleHeaderRow(sheet.addRow(headers));
      for (const row of rows) {
        const excelRow = sheet.addRow(row);
        for (const col of moneyCols) excelRow.getCell(col + 1).numFmt = moneyFmt;
      }
      if (totalRow) {
        const excelRow = sheet.addRow(totalRow);
        this.styleTotalRow(excelRow);
        for (const col of moneyCols) excelRow.getCell(col + 1).numFmt = moneyFmt;
      }
      if (!rows.length) sheet.addRow(['لا توجد بيانات لهذه الفترة']);
    };

    if (kind === 'sales') {
      const [s, trend, topItems, payments, lowStock, orderTypes] = await Promise.all([
        this.analytics.salesSummary(userId, locationId, from, to),
        this.analytics.salesTrend(userId, locationId, from, to),
        this.analytics.topItems(userId, locationId, from, to, 50),
        this.analytics.paymentMethodsSummary(userId, locationId, from, to),
        this.analytics.lowStock(userId, locationId),
        this.orderTypes.findAll(),
      ]);
      const channelLabel = new Map(orderTypes.map((t) => [t.code, t.name]));
      addKpiRows([
        ['عدد الطلبات', s.orderCount], ['الإيراد', s.revenue, true], ['صافي المبيعات', s.netSales, true],
        ['الضريبة', s.vatCollected, true], ['متوسط الطلب', s.averageOrderValue, true],
      ]);
      addTableSheet('اتجاه المبيعات اليومي', ['التاريخ', 'عدد الطلبات', 'الإيراد'], trend.map((t) => [t.date, t.orderCount, t.revenue]), [2]);
      addTableSheet('الإيراد حسب القناة', ['القناة', 'عدد الطلبات', 'الإيراد'], s.byChannel.map((c) => [channelLabel.get(c.channel) || c.channel, c.orderCount, c.revenue]), [2],
        ['الإجمالي', s.byChannel.reduce((a, c) => a + c.orderCount, 0), s.byChannel.reduce((a, c) => a + c.revenue, 0)]);
      addTableSheet('طرق الدفع', ['الطريقة', 'العدد', 'الإجمالي'], payments.byMethod.map((m) => [DASH_PAYMENT_METHOD_LABEL[m.method] || m.method, m.count, m.total]), [2]);
      addTableSheet('الأصناف الأكثر مبيعًا', ['الصنف', 'الكمية', 'الإيراد'], topItems.map((i) => [i.name, i.quantity, i.revenue]), [2]);
      addTableSheet('تنبيهات نقص المخزون', ['الصنف', 'الكمية المتبقية', 'الوحدة', 'الحد الأدنى'], lowStock.map((r) => [r.name, r.quantity, r.unit, r.lowStockThreshold]));
    } else if (kind === 'production') {
      const res = await this.analytics.productionSummary(userId, locationId, from, to);
      addKpiRows([['عدد أوامر الإنتاج', res.ordersCount], ['إجمالي التكلفة', res.totalCost, true]]);
      addTableSheet('أوامر الإنتاج حسب الحالة', ['الحالة', 'العدد'], res.byStatus.map((s) => [DASH_PRODUCTION_STATUS_LABEL[s.status] || s.status, s.count]));
      addTableSheet('التكلفة حسب المنتج', ['المنتج', 'عدد الأوامر', 'الكمية المنتجة', 'التكلفة الإجمالية', 'متوسط تكلفة الوحدة'],
        res.byOutput.map((o) => [o.name, o.ordersCount, o.totalOutputQuantity, o.totalCost, o.avgUnitCost]), [3, 4]);
    } else if (kind === 'purchasing') {
      const res = await this.analytics.purchasingSummary(userId, locationId, from, to);
      addKpiRows([['عدد الأوامر', res.orderCount], ['إجمالي الإنفاق', res.totalSpend, true], ['ضريبة تقديرية', res.estimatedVat, true]]);
      addTableSheet('أوامر الشراء حسب الحالة', ['الحالة', 'العدد'], res.byStatus.map((s) => [DASH_PO_STATUS_LABEL[s.status] || s.status, s.count]));
      addTableSheet('أعلى الموردين إنفاقًا', ['المورد', 'الإنفاق'], res.topSuppliers.map((s) => [s.supplierName, s.spend]), [1]);
    } else if (kind === 'items') {
      const [res, menuEng] = await Promise.all([this.analytics.menuItemCosts(userId, locationId), this.analytics.menuEngineering(userId, locationId, from, to)]);
      const withRecipe = res.filter((i) => i.hasRecipe);
      const avgCostPercent = withRecipe.length ? withRecipe.reduce((a, i) => a + i.costPercent, 0) / withRecipe.length : 0;
      addKpiRows([['عدد الأصناف', res.length], ['متوسط نسبة التكلفة %', Math.round(avgCostPercent * 10) / 10]]);
      addTableSheet('تكلفة وهامش ربح الأصناف', ['الصنف', 'السعر', 'التكلفة', 'نسبة التكلفة %', 'هامش الربح', 'لديه وصفة'],
        res.map((i) => [i.name, i.price, i.cost, i.costPercent, i.grossMargin, i.hasRecipe ? 'نعم' : 'لا']), [1, 2, 4]);
      addTableSheet('هندسة المنيو', ['الصنف', 'الكمية المباعة', 'الشعبية %', 'هامش الربح', 'التصنيف'],
        menuEng.items.map((i) => [i.name, i.quantity, i.popularityPercent, i.margin, DASH_MENU_ENG_LABEL[i.classification]]), [3]);
    } else {
      const [valuation, lowStock] = await Promise.all([this.analytics.inventoryValuation(userId, locationId), this.analytics.lowStock(userId, locationId)]);
      addKpiRows([['القيمة الإجمالية للمخزون', valuation.totalValue, true], ['أصناف منخفضة المخزون', lowStock.length]]);
      addTableSheet('قيمة المخزون حسب المكوّن', ['المكوّن', 'الكمية', 'الوحدة', 'القيمة'], valuation.lines.map((l) => [l.name, l.quantity, l.unit, l.value]), [3],
        ['الإجمالي', '', '', valuation.totalValue]);
      addTableSheet('تنبيهات نقص المخزون', ['المكوّن', 'الفرع', 'الكمية المتبقية', 'الوحدة', 'الحد الأدنى'],
        lowStock.map((r) => [r.name, r.locationName, r.quantity, r.unit, r.lowStockThreshold]));
    }

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // Same Arabic labels/section structure as buildDashboardXlsx above --
  // this is the export the user complained didn't "look like the screen":
  // the previous pdfkit version had only English text and, structurally,
  // could never draw the on-screen dashboard's own Chart.js charts at all.
  // Rendering through a real browser page (report-html.util.ts +
  // pdf-render.util.ts) fixes both -- same Arabic labels as the XLSX/
  // on-screen dashboard, and the SAME chart types the screen shows
  // (mountChartOrEmpty/doughnutChartConfig/barChartConfig in
  // admin_panel.html) built from the exact same numbers.
  private readonly DASHBOARD_TITLE: Record<DashboardKind, string> = {
    sales: 'لوحة المبيعات', production: 'لوحة الإنتاج', purchasing: 'لوحة المشتريات',
    items: 'لوحة الأصناف', inventory: 'لوحة المخزون',
  };

  private async buildDashboardPdf(
    kind: DashboardKind,
    locationName: string,
    userId: string,
    locationId?: string,
    from?: string,
    to?: string,
  ): Promise<Buffer> {
    const periodLabel = from || to ? `الفترة: ${from ?? '...'} → ${to ?? '...'}` : 'كل الفترات';
    let bodyHtml = '';
    const charts: Array<{ canvasId: string; title: string; config: Record<string, unknown> }> = [];

    if (kind === 'sales') {
      const [s, topItems, lowStock, payments, orderTypes] = await Promise.all([
        this.analytics.salesSummary(userId, locationId, from, to),
        this.analytics.topItems(userId, locationId, from, to, 20),
        this.analytics.lowStock(userId, locationId),
        this.analytics.paymentMethodsSummary(userId, locationId, from, to),
        this.orderTypes.findAll(),
      ]);
      const channelLabel = new Map(orderTypes.map((t) => [t.code, t.name]));
      if (s.byChannel.length) charts.push({ canvasId: 'c1', title: 'الإيراد حسب القناة', config: doughnutChartConfig(s.byChannel.map((c) => channelLabel.get(c.channel) || c.channel), s.byChannel.map((c) => c.revenue)) });
      if (payments.byMethod.length) charts.push({ canvasId: 'c2', title: 'طرق الدفع', config: doughnutChartConfig(payments.byMethod.map((m) => DASH_PAYMENT_METHOD_LABEL[m.method] || m.method), payments.byMethod.map((m) => m.total)) });
      const topForChart = topItems.slice(0, 10);
      if (topForChart.length) charts.push({ canvasId: 'c3', title: 'الأصناف الأكثر مبيعًا', config: barChartConfig(topForChart.map((i) => i.name), topForChart.map((i) => i.revenue), 'الإيراد', true) });

      bodyHtml = `
        ${sectionHeading('ملخص المبيعات')}
        <div class="stats-row">
          ${statTile('عدد الطلبات', s.orderCount)}${statTile('الإيراد', fmtMoney(s.revenue))}${statTile('صافي المبيعات', fmtMoney(s.netSales))}
          ${statTile('الضريبة', fmtMoney(s.vatCollected))}${statTile('متوسط الطلب', fmtMoney(s.averageOrderValue))}
        </div>
        ${sectionHeading('الإيراد حسب القناة')}
        ${dataTable(['القناة', 'عدد الطلبات', 'الإيراد'], s.byChannel.map((c) => [channelLabel.get(c.channel) || c.channel, c.orderCount, fmtMoney(c.revenue)]), 'لا توجد مبيعات في هذه الفترة')}
        ${sectionHeading('طرق الدفع')}
        ${dataTable(['الطريقة', 'العدد', 'الإجمالي'], payments.byMethod.map((m) => [DASH_PAYMENT_METHOD_LABEL[m.method] || m.method, m.count, fmtMoney(m.total)]), 'لا توجد مدفوعات في هذه الفترة')}
        ${sectionHeading('الأصناف الأكثر مبيعًا')}
        ${dataTable(['الصنف', 'الكمية', 'الإيراد'], topItems.map((i) => [i.name, i.quantity, fmtMoney(i.revenue)]), 'لا توجد مبيعات في هذه الفترة')}
        ${sectionHeading('تنبيهات نقص المخزون')}
        ${dataTable(['الصنف', 'الكمية المتبقية', 'الوحدة', 'الحد الأدنى'], lowStock.map((r) => [r.name, r.quantity, r.unit, r.lowStockThreshold]), 'لا توجد تنبيهات نقص مخزون')}
      `;
    } else if (kind === 'production') {
      const res = await this.analytics.productionSummary(userId, locationId, from, to);
      if (res.byStatus.length) charts.push({ canvasId: 'c1', title: 'أوامر الإنتاج حسب الحالة', config: doughnutChartConfig(res.byStatus.map((s) => DASH_PRODUCTION_STATUS_LABEL[s.status] || s.status), res.byStatus.map((s) => s.count)) });
      const topOutput = res.byOutput.slice(0, 8);
      if (topOutput.length) charts.push({ canvasId: 'c2', title: 'التكلفة حسب المنتج', config: barChartConfig(topOutput.map((o) => o.name), topOutput.map((o) => o.totalCost), 'التكلفة', true) });

      bodyHtml = `
        ${sectionHeading('ملخص الإنتاج')}
        <div class="stats-row">${statTile('عدد أوامر الإنتاج', res.ordersCount)}${statTile('إجمالي التكلفة', fmtMoney(res.totalCost))}</div>
        ${sectionHeading('أوامر الإنتاج حسب الحالة')}
        ${dataTable(['الحالة', 'العدد'], res.byStatus.map((s) => [DASH_PRODUCTION_STATUS_LABEL[s.status] || s.status, s.count]), 'لا توجد أوامر إنتاج في هذه الفترة')}
        ${sectionHeading('التكلفة حسب المنتج')}
        ${dataTable(['المنتج', 'عدد الأوامر', 'الكمية المنتجة', 'التكلفة الإجمالية', 'متوسط تكلفة الوحدة'], res.byOutput.map((o) => [o.name, o.ordersCount, fmtMoney(o.totalOutputQuantity), fmtMoney(o.totalCost), fmtMoney(o.avgUnitCost)]), 'لا توجد تكاليف إنتاج مسجّلة بعد')}
      `;
    } else if (kind === 'purchasing') {
      const res = await this.analytics.purchasingSummary(userId, locationId, from, to);
      if (res.byStatus.length) charts.push({ canvasId: 'c1', title: 'أوامر الشراء حسب الحالة', config: doughnutChartConfig(res.byStatus.map((s) => DASH_PO_STATUS_LABEL[s.status] || s.status), res.byStatus.map((s) => s.count)) });
      if (res.topSuppliers.length) charts.push({ canvasId: 'c2', title: 'أعلى الموردين إنفاقًا', config: barChartConfig(res.topSuppliers.map((s) => s.supplierName), res.topSuppliers.map((s) => s.spend), 'الإنفاق', true) });

      bodyHtml = `
        ${sectionHeading('ملخص المشتريات')}
        <div class="stats-row">${statTile('عدد الأوامر', res.orderCount)}${statTile('إجمالي الإنفاق', fmtMoney(res.totalSpend))}${statTile('ضريبة تقديرية', fmtMoney(res.estimatedVat))}</div>
        ${sectionHeading('أوامر الشراء حسب الحالة')}
        ${dataTable(['الحالة', 'العدد'], res.byStatus.map((s) => [DASH_PO_STATUS_LABEL[s.status] || s.status, s.count]), 'لا توجد أوامر شراء في هذه الفترة')}
        ${sectionHeading('أعلى الموردين إنفاقًا')}
        ${dataTable(['المورد', 'الإنفاق'], res.topSuppliers.map((s) => [s.supplierName, fmtMoney(s.spend)]), 'لا يوجد إنفاق معتمد بعد لهذه الفترة')}
      `;
    } else if (kind === 'items') {
      const [res, menuEng] = await Promise.all([this.analytics.menuItemCosts(userId, locationId), this.analytics.menuEngineering(userId, locationId, from, to)]);
      const withRecipe = res.filter((i) => i.hasRecipe);
      const avgCostPercent = withRecipe.length ? withRecipe.reduce((a, i) => a + i.costPercent, 0) / withRecipe.length : 0;
      const topMargin = [...withRecipe].sort((a, b) => b.grossMargin - a.grossMargin).slice(0, 8);
      const topCost = [...withRecipe].sort((a, b) => b.costPercent - a.costPercent).slice(0, 8);
      if (topMargin.length) charts.push({ canvasId: 'c1', title: 'أعلى الأصناف هامش ربح', config: barChartConfig(topMargin.map((i) => i.name), topMargin.map((i) => i.grossMargin), 'هامش الربح', true) });
      if (topCost.length) charts.push({ canvasId: 'c2', title: 'أعلى الأصناف نسبة تكلفة', config: barChartConfig(topCost.map((i) => i.name), topCost.map((i) => i.costPercent), 'نسبة التكلفة %', true) });

      bodyHtml = `
        ${sectionHeading('ملخص الأصناف')}
        <div class="stats-row">${statTile('عدد الأصناف', res.length)}${statTile('متوسط نسبة التكلفة', avgCostPercent.toFixed(1) + '%')}</div>
        ${sectionHeading('تكلفة وهامش ربح الأصناف')}
        ${dataTable(['الصنف', 'السعر', 'التكلفة', 'نسبة التكلفة %', 'هامش الربح', 'لديه وصفة'], res.map((i) => [i.name, fmtMoney(i.price), fmtMoney(i.cost), i.costPercent.toFixed(1) + '%', fmtMoney(i.grossMargin), i.hasRecipe ? 'نعم' : 'لا']), 'لا توجد أصناف')}
        ${sectionHeading('هندسة المنيو')}
        <div class="stats-row">
          ${statTile('⭐ نجوم', menuEng.counts.STAR)}${statTile('🐴 أحصنة عمل', menuEng.counts.PLOWHORSE)}
          ${statTile('🧩 ألغاز', menuEng.counts.PUZZLE)}${statTile('🐶 ضعيفة', menuEng.counts.DOG)}
        </div>
        ${dataTable(['الصنف', 'الكمية المباعة', 'الشعبية %', 'هامش الربح', 'التصنيف'], menuEng.items.map((i) => [i.name, i.quantity, i.popularityPercent.toFixed(1) + '%', fmtMoney(i.margin), DASH_MENU_ENG_LABEL[i.classification]]), 'لا توجد مبيعات في هذه الفترة')}
      `;
    } else {
      const [valuation, lowStock] = await Promise.all([this.analytics.inventoryValuation(userId, locationId), this.analytics.lowStock(userId, locationId)]);
      const topValue = valuation.lines.slice(0, 8);
      if (topValue.length) charts.push({ canvasId: 'c1', title: 'قيمة المخزون حسب المكوّن', config: barChartConfig(topValue.map((l) => l.name), topValue.map((l) => l.value), 'القيمة', true) });

      bodyHtml = `
        ${sectionHeading('ملخص المخزون')}
        <div class="stats-row">${statTile('القيمة الإجمالية للمخزون', fmtMoney(valuation.totalValue))}${statTile('أصناف منخفضة المخزون', lowStock.length)}</div>
        ${sectionHeading('قيمة المخزون حسب المكوّن')}
        ${dataTable(['المكوّن', 'الكمية', 'الوحدة', 'القيمة'], valuation.lines.map((l) => [l.name, fmtMoney(l.quantity), l.unit, fmtMoney(l.value)]), 'لا يوجد مخزون مسجّل بعد')}
        ${sectionHeading('تنبيهات نقص المخزون')}
        ${dataTable(['المكوّن', 'الفرع', 'الكمية المتبقية', 'الوحدة', 'الحد الأدنى'], lowStock.map((r) => [r.name, r.locationName, r.quantity, r.unit, r.lowStockThreshold]), 'لا توجد تنبيهات نقص مخزون')}
      `;
    }

    const html = reportShell({ title: this.DASHBOARD_TITLE[kind], subtitle: locationName, periodLabel, charts, bodyHtml });
    return renderHtmlToPdf(html);
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
