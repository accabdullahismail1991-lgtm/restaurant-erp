import * as fs from 'fs';
import { Browser, chromium } from 'playwright';

// Headless Chromium behind the PDF exports -- one browser process, reused
// across every renderHtmlToPdf() call (launching Chromium per-report would
// be slow and, for generateForAllLocations' per-location loop, wasteful).
// Lazily started on first use so a plain `npm run start` that never
// generates a report never pays the launch cost.
let browserPromise: Promise<Browser> | null = null;

// This sandbox's Playwright install (see the environment notes: dev server
// pre-installs Chromium at /opt/pw-browsers) already has a working
// chromium binary -- reusing it avoids a redundant download and matches
// what every other Playwright-driven script in this repo does. Production
// (e.g. Render) has no such fixed path, so this only applies when it
// actually exists; otherwise Playwright resolves its own managed install
// (installed via `npx playwright install chromium` as part of the deploy).
const SANDBOX_CHROMIUM_PATH = '/opt/pw-browsers/chromium';

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const executablePath = fs.existsSync(SANDBOX_CHROMIUM_PATH) ? SANDBOX_CHROMIUM_PATH : undefined;
    browserPromise = chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  }
  return browserPromise;
}

// Renders a fully self-contained HTML document (see report-html.util.ts --
// fonts and Chart.js are inlined, no network fetch needed) to a PDF buffer
// via a real browser page. This is what makes the export visually match
// the on-screen report: real Arabic text shaping/BiDi and real rendered
// <canvas> charts, neither of which pdfkit (the previous approach) could
// do. Waits for the page's own `window.__reportReady` flag (set by
// report-html.util.ts's reportShell() once every Chart.js instance has
// finished constructing) rather than a fixed delay, with a bounded
// timeout so a page that never sets it (a bug, or no charts at all)
// doesn't hang the request forever.
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __reportReady?: boolean }).__reportReady === true, { timeout: 8000 }).catch(() => {
      // A report with no charts still sets the flag (see reportShell), so
      // this only fires on a genuine rendering problem -- proceeding
      // anyway still produces a PDF (just possibly missing a chart image)
      // rather than failing the whole export outright.
    });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' } });
  } finally {
    await page.close();
  }
}

// Called from ReportsService's OnModuleDestroy so the Chromium subprocess
// doesn't leak past app shutdown -- matters most for the e2e test runner,
// which boots/tears down a full Nest app per spec file in one long-lived
// process (a lingering browser per file would accumulate).
export async function closeReportBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    browserPromise = null;
    await browser.close();
  }
}
