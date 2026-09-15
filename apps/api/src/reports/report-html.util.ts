import * as fs from 'fs';
import * as path from 'path';

// Exported PDF reports render through a real headless-Chromium page (see
// pdf-render.util.ts) instead of drawing PDF primitives by hand -- this is
// what actually makes the export "look like the screen": Chromium does
// full Arabic shaping/BiDi (pdfkit never did, see the removed comment this
// replaces) and can render a real <canvas> Chart.js chart, which a
// hand-drawn PDF simply cannot. This module builds the self-contained HTML
// (fonts + Chart.js inlined, no network access needed at render time) that
// page gets fed.

// Same __dirname-vs-dist distance problem ARABIC_FONT_PATH originally
// solved in reports.service.ts -- both candidate depths are tried so this
// works identically under ts-node/ts-jest (src) and the compiled build
// (dist/src), without depending on process.cwd().
function resolveAssetPath(...segments: string[]): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', ...segments),
    path.join(__dirname, '..', '..', '..', 'assets', ...segments),
    path.join(process.cwd(), 'assets', ...segments),
    path.join(process.cwd(), 'apps', 'api', 'assets', ...segments),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

let cachedFontFace: string | null = null;
function arabicFontFaceCss(): string {
  if (cachedFontFace) return cachedFontFace;
  const fontPath = resolveAssetPath('fonts', 'NotoSansArabic.ttf');
  const base64 = fs.readFileSync(fontPath).toString('base64');
  cachedFontFace = `@font-face{font-family:'NotoSansArabic';src:url(data:font/ttf;base64,${base64}) format('truetype');font-weight:100 900;}`;
  return cachedFontFace;
}

let cachedChartJs: string | null = null;
function chartJsScript(): string {
  if (cachedChartJs) return cachedChartJs;
  const jsPath = resolveAssetPath('vendor', 'vendor-chart.min.js');
  cachedChartJs = fs.readFileSync(jsPath, 'utf8');
  return cachedChartJs;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Matches admin_panel.html's fmtMoney (two decimals, thousands separator).
export function fmtMoney(n: number): string {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function statTile(label: string, value: string | number): string {
  return `<div class="stat-tile"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div>`;
}

export function sectionHeading(title: string): string {
  return `<h2 class="section-heading">${escapeHtml(title)}</h2>`;
}

export function dataTable(headers: string[], rows: Array<Array<string | number>>, emptyText: string): string {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : `<tbody><tr><td colspan="${headers.length}" class="empty">${escapeHtml(emptyText)}</td></tr></tbody>`;
  return `<table class="report-table">${thead}${tbody}</table>`;
}

// Same palette/config shapes as admin_panel.html's CHART_COLORS/
// barChartConfig/doughnutChartConfig/lineChartConfig -- kept in sync
// deliberately so an exported chart looks like the one on screen it came
// from. animation:false is the one deviation: Chart.js's construction
// still draws the canvas synchronously with it off, so the PDF capture
// (right after all charts are constructed, see reportShell below) doesn't
// need to wait out an animation that would never be seen anyway.
export interface ChartSpec {
  canvasId: string;
  title: string;
  height?: number;
  config: Record<string, unknown>;
}
const CHART_COLORS = ['#3730a3', '#0891b2', '#d97706', '#dc2626', '#059669', '#7c3aed', '#0284c7', '#be185d'];
// maintainAspectRatio:false -- paired with reportShell's fixed-height
// .chart-canvas-wrap below, this is what keeps every chart's rendered
// height bounded and predictable (Chart.js's default aspect-ratio sizing
// otherwise grows with the container's width, which is exactly what
// blew a chart across a page break the first time this was tried against
// a real A4 page).
export function doughnutChartConfig(labels: string[], data: number[]) {
  return {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: CHART_COLORS }] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } } } },
  };
}
export function barChartConfig(labels: string[], data: number[], label: string, horizontal = false) {
  return {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: CHART_COLORS[0] }] },
    options: { animation: false, indexAxis: horizontal ? 'y' : 'x', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } },
  };
}
export function lineChartConfig(labels: string[], data: number[], label: string) {
  return {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: '#3730a3', backgroundColor: 'rgba(55,48,163,.12)', fill: true, tension: 0.3 }] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  };
}

const BASE_STYLES = `
  *{box-sizing:border-box;}
  body{margin:0;font-family:'NotoSansArabic','Segoe UI',Tahoma,Arial,sans-serif;color:#171923;font-size:12px;}
  .band{background:#3730a3;color:#fff;padding:18px 28px;}
  .band h1{margin:0;font-size:20px;}
  .band .sub{margin-top:4px;font-size:12px;opacity:.9;}
  .meta{color:#666;font-size:10.5px;padding:10px 28px 0;}
  .page{padding:0 28px 24px;}
  .section-heading{color:#3730a3;font-size:14px;margin:20px 0 8px;border-bottom:2px solid #3730a3;padding-bottom:4px;}
  .stats-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;}
  .stat-tile{background:#f5f6fa;border:1px solid #e2e4ee;border-radius:8px;padding:8px 12px;min-width:120px;}
  .stat-label{color:#666;font-size:10px;}
  .stat-value{font-weight:700;font-size:14px;margin-top:2px;}
  table.report-table{width:100%;border-collapse:collapse;margin-top:6px;font-size:11px;}
  table.report-table th{background:#f5f6fa;border-bottom:2px solid #e2e4ee;text-align:right;padding:6px 8px;}
  table.report-table td{border-bottom:1px solid #eee;padding:5px 8px;text-align:right;}
  table.report-table td.empty{text-align:center;color:#999;}
  .charts-row{display:flex;flex-wrap:wrap;gap:16px;margin-top:8px;}
  .chart-card{flex:1 1 320px;background:#f5f6fa;border:1px solid #e2e4ee;border-radius:8px;padding:10px;page-break-inside:avoid;break-inside:avoid;}
  .chart-card h3{margin:0 0 8px;font-size:12px;color:#333;}
  .chart-canvas-wrap{position:relative;height:220px;}
  .chart-canvas-wrap canvas{width:100% !important;height:100% !important;}
  .stat-tile{page-break-inside:avoid;break-inside:avoid;}
  .section-heading{page-break-after:avoid;break-after:avoid;}
  table.report-table tr{page-break-inside:avoid;break-inside:avoid;}
  .footer{color:#999;font-size:9.5px;text-align:center;padding:10px 0;}
`;

// One HTML document per export -- charts is a JS-side array (built inline,
// not passed as a JSON blob) because Chart.js configs can carry callback
// functions (see menu-engineering's tooltip.callbacks.label in
// admin_panel.html) that don't survive JSON.stringify. Each entry becomes
// its own <canvas> + `new Chart(...)` call; window.__reportReady is set
// only after every chart has finished constructing, which is what
// pdf-render.util.ts's renderHtmlToPdf() waits on before calling page.pdf().
export function reportShell(opts: { title: string; subtitle: string; periodLabel: string; bodyHtml: string; charts: ChartSpec[] }): string {
  const chartsHtml = opts.charts.length
    ? `<div class="charts-row">${opts.charts.map((c) => `<div class="chart-card" style="flex-basis:${opts.charts.length === 1 ? '100%' : '320px'}"><h3>${escapeHtml(c.title)}</h3><div class="chart-canvas-wrap" style="height:${c.height ?? 220}px"><canvas id="${c.canvasId}"></canvas></div></div>`).join('')}</div>`
    : '';
  const chartScripts = opts.charts
    .map((c) => `new Chart(document.getElementById(${JSON.stringify(c.canvasId)}).getContext('2d'), ${JSON.stringify(c.config)});`)
    .join('\n');

  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<style>${arabicFontFaceCss()}${BASE_STYLES}</style>
</head>
<body>
  <div class="band"><h1>${escapeHtml(opts.title)}</h1><div class="sub">${escapeHtml(opts.subtitle)}</div></div>
  <div class="meta">${escapeHtml(opts.periodLabel)}</div>
  <div class="page">
    ${chartsHtml}
    ${opts.bodyHtml}
  </div>
  <div class="footer">تم الإنشاء: ${escapeHtml(new Date().toLocaleString('ar-SA-u-ca-gregory-nu-latn'))}</div>
  <script>${chartJsScript()}</script>
  <script>
    ${chartScripts}
    window.__reportReady = true;
  </script>
</body>
</html>`;
}
