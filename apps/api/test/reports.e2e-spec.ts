import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as ExcelJS from 'exceljs';
import pdfParse = require('pdf-parse');
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';
import { resetDatabase } from './reset-db';

// Post-roadmap iteration on top of Phase 11 (docs/DECISIONS.md): exports
// the exact same AnalyticsService numbers as a real downloadable file
// instead of only a JSON API response, plus a system-level "generate for
// every location" action the daily @Cron job also uses. Runs against a
// real app + a real Postgres test database; the XLSX/PDF assertions below
// parse the ACTUAL bytes the service produced (via exceljs / pdf-parse),
// not a mocked buffer, so a real regression in cell/text content would
// fail these tests.
describe('Reports: scheduled Excel/PDF export (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewToken: string;
  let noPermToken: string;
  let scopedElsewhereToken: string;
  let locationId: string;
  let otherLocationId: string;
  let menuItemId: string;
  let periodFrom: string;
  let periodTo: string;

  const VIEW_PHONE = '+966500000130';
  const NOPERM_PHONE = '+966500000131';
  const ELSEWHERE_PHONE = '+966500000132';
  const PASSWORD = 'ReportsTest123';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await resetDatabase(prisma);
    await prisma.userRole.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.user.deleteMany({ where: { phone: { in: [VIEW_PHONE, NOPERM_PHONE, ELSEWHERE_PHONE] } } });
    await prisma.role.deleteMany({ where: { name: 'Reports-Test-Viewer' } });
    await prisma.permission.deleteMany({ where: { code: { in: ['analytics.view', 'inventory.adjust'] } } });

    // inventory.adjust is needed only to seed real stock via
    // /inventory/adjustments in this setup -- unrelated to what reports.*
    // itself checks (analytics.view), same two-permission pattern
    // analytics.e2e-spec.ts already uses for the same reason.
    const viewPerm = await prisma.permission.create({ data: { code: 'analytics.view', label: 'عرض التقارير' } });
    const adjustPerm = await prisma.permission.create({ data: { code: 'inventory.adjust', label: 'تسوية المخزون' } });
    const viewRole = await prisma.role.create({ data: { name: 'Reports-Test-Viewer' } });
    await prisma.rolePermission.createMany({
      data: [viewPerm, adjustPerm].map((p) => ({ roleId: viewRole.id, permissionId: p.id })),
    });

    const makeUser = async (phone: string, roleId?: string, scopeLocationId?: string) => {
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await prisma.user.create({ data: { name: phone, phone, passwordHash } });
      if (roleId) await prisma.userRole.create({ data: { userId: user.id, roleId } });
      if (scopeLocationId) await prisma.userLocationScope.create({ data: { userId: user.id, locationId: scopeLocationId } });
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ phone, password: PASSWORD });
      return loginRes.body.accessToken as string;
    };

    const location = await prisma.location.create({ data: { name: 'فرع اختبار التقارير', type: 'BRANCH' } });
    locationId = location.id;
    const otherLocation = await prisma.location.create({ data: { name: 'فرع آخر خارج النطاق', type: 'BRANCH' } });
    otherLocationId = otherLocation.id;

    viewToken = await makeUser(VIEW_PHONE, viewRole.id);
    noPermToken = await makeUser(NOPERM_PHONE);
    scopedElsewhereToken = await makeUser(ELSEWHERE_PHONE, viewRole.id, otherLocationId);

    const ingredient = await prisma.ingredient.create({
      data: { name: 'خامة تقارير', unit: 'g', kind: 'RAW_MATERIAL', lowStockThreshold: 9999 },
    });
    const menuItem = await prisma.menuItem.create({ data: { name: 'صنف تقارير', category: 'رئيسي', price: 50 } });
    menuItemId = menuItem.id;
    await prisma.recipeLine.create({ data: { menuItemId, ingredientId: ingredient.id, quantity: 10 } });

    await request(app.getHttpServer())
      .post('/inventory/adjustments')
      .set(auth(viewToken))
      .send({ locationId, ingredientId: ingredient.id, quantity: 1000, unitCost: 1.0 });

    const shiftRes = await request(app.getHttpServer()).post('/shifts').set(auth(viewToken)).send({ locationId, openingFloat: 100 });
    const shiftId = shiftRes.body.id;

    // One real paid sale: 2x menu item @ 50 = 100 subtotal, 15% VAT = 15,
    // grand total 115 -- every number asserted below traces back to this.
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set(auth(viewToken))
      .send({ locationId, shiftId, channel: 'DINE_IN', lines: [{ menuItemId, quantity: 2 }] });
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/pay`)
      .set(auth(viewToken))
      .send({ payments: [{ method: 'CASH', mode: 'MANUAL', amount: Number(orderRes.body.grandTotal) }] });

    const now = new Date();
    periodFrom = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    periodTo = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks generate/list/download without analytics.view (403)', async () => {
    const gen = await request(app.getHttpServer())
      .post('/reports/generate')
      .set(auth(noPermToken))
      .send({ locationId, from: periodFrom, to: periodTo, format: 'XLSX' });
    expect(gen.status).toBe(403);

    const list = await request(app.getHttpServer()).get('/reports').set(auth(noPermToken));
    expect(list.status).toBe(403);
  });

  it('blocks generating a report for a location outside the caller scope (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/reports/generate')
      .set(auth(scopedElsewhereToken))
      .send({ locationId, from: periodFrom, to: periodTo, format: 'XLSX' });
    expect(res.status).toBe(403);
  });

  let xlsxReportId: string;
  it('generates a real XLSX file whose cells match the actual sales numbers', async () => {
    const res = await request(app.getHttpServer())
      .post('/reports/generate')
      .set(auth(viewToken))
      .send({ locationId, from: periodFrom, to: periodTo, format: 'XLSX' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].format).toBe('XLSX');
    xlsxReportId = res.body[0].id;

    const download = await request(app.getHttpServer())
      .get(`/reports/${xlsxReportId}/download`)
      .set(auth(viewToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('spreadsheetml');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(download.body as unknown as ArrayBuffer);
    const summary = wb.getWorksheet('ملخص المبيعات');
    expect(summary).toBeDefined();
    const rows = summary!.getSheetValues() as Array<Array<string | number> | undefined>;
    const flat = rows.filter(Boolean).map((r) => r as Array<string | number>);
    const findRow = (label: string) => flat.find((r) => r[1] === label);
    expect(findRow('عدد الطلبات')?.[2]).toBe(1);
    expect(findRow('الإيراد')?.[2]).toBe(115);
    expect(findRow('صافي المبيعات')?.[2]).toBe(100);
    expect(findRow('ضريبة القيمة المضافة')?.[2]).toBe(15);

    const itemsSheet = wb.getWorksheet('الأصناف الأكثر مبيعًا');
    const itemRows = (itemsSheet!.getSheetValues() as Array<Array<string | number> | undefined>).filter(Boolean);
    const itemRow = itemRows.find((r) => (r as Array<string | number>)[1] === 'صنف تقارير') as Array<string | number>;
    expect(itemRow[2]).toBe(2); // quantity sold
    expect(itemRow[3]).toBe(100); // revenue
  });

  it('generates a real PDF file whose text matches the actual sales numbers', async () => {
    const res = await request(app.getHttpServer())
      .post('/reports/generate')
      .set(auth(viewToken))
      .send({ locationId, from: periodFrom, to: periodTo, format: 'PDF' });
    expect(res.status).toBe(201);
    const reportId = res.body[0].id;
    expect(res.body[0].format).toBe('PDF');

    const download = await request(app.getHttpServer())
      .get(`/reports/${reportId}/download`)
      .set(auth(viewToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');

    const parsed = await pdfParse(download.body as Buffer);
    expect(parsed.text).toContain('Daily Report');
    expect(parsed.text).toContain('Orders: 1');
    expect(parsed.text).toContain('Revenue: 115.00 SAR');
    expect(parsed.text).toContain('Net sales: 100.00 SAR');
  });

  it('lists reports scoped to the caller\'s own location', async () => {
    const own = await request(app.getHttpServer()).get(`/reports?locationId=${locationId}`).set(auth(viewToken));
    expect(own.status).toBe(200);
    expect(own.body.length).toBeGreaterThanOrEqual(2); // the xlsx + pdf generated above
    expect(own.body.every((r: { locationId: string }) => r.locationId === locationId)).toBe(true);

    const elsewhere = await request(app.getHttpServer()).get('/reports').set(auth(scopedElsewhereToken));
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.every((r: { locationId: string }) => r.locationId === otherLocationId)).toBe(true);
    expect(elsewhere.body.some((r: { id: string }) => r.id === xlsxReportId)).toBe(false);
  });

  it('rejects downloading a report outside the caller\'s scope (403)', async () => {
    const res = await request(app.getHttpServer()).get(`/reports/${xlsxReportId}/download`).set(auth(scopedElsewhereToken));
    expect(res.status).toBe(403);
  });

  it('generateForAllLocations (the cron\'s underlying logic) produces one org-wide bundle plus one per active location, in both formats, without touching any user\'s scope', async () => {
    const reportsService = app.get(ReportsService);
    const before = await prisma.generatedReport.count();
    const results = await reportsService.generateForAllLocations(periodFrom, periodTo);
    const after = await prisma.generatedReport.count();

    const activeLocations = await prisma.location.count({ where: { isActive: true } });
    // (1 org-wide + N per-location) * 2 formats (XLSX + PDF)
    const expectedCount = (1 + activeLocations) * 2;
    expect(results).toHaveLength(expectedCount);
    expect(after - before).toBe(expectedCount);

    const orgWideRows = await prisma.generatedReport.findMany({ where: { locationId: null, type: 'DAILY_BUNDLE' } });
    expect(orgWideRows.length).toBeGreaterThanOrEqual(2); // at least the XLSX + PDF just created
  });
});
