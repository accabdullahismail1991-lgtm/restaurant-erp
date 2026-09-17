import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, generateKeyPairSync, createPrivateKey, createSign, createHash, KeyObject } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { buildInvoiceXml } from './invoice-xml.util';
import { buildQr } from './qr.util';

const round2 = (n: number) => Math.round(n * 100) / 100;

// base64(hex(SHA-256("0"))) -- ZATCA's published Previous Invoice Hash
// value for the very first invoice in a chain (there is no real
// predecessor to reference yet). Verified by direct computation, not
// copied blind: crypto.createHash('sha256').update('0').digest('hex')
// then Buffer.from(thatHexString).toString('base64').
const ZATCA_GENESIS_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

type Db = Pick<PrismaService, 'order' | 'orderReturn' | 'menuItem' | 'location'>;

// Phase 9 (docs/DECISIONS.md #3): every paid order gets a ZATCA Simplified
// Tax Invoice generated and digitally signed LOCALLY, at sale time -- that
// much this service does for real. What it deliberately does NOT do is
// submit that invoice to ZATCA's actual Fatoora platform: getting a real
// Cryptographic Stamp Identifier (CSID) requires onboarding through their
// portal (a real taxpayer registration + OTP, even for their sandbox), and
// this environment has neither. So the EC key pair below is a local
// stand-in for a CSID-issued certificate -- it produces a structurally and
// cryptographically real signature (independently verifiable with Node's
// own crypto.verify, see test/zatca.e2e-spec.ts), but it is NOT a
// certificate ZATCA itself has issued or would recognize. Swapping in a
// real CSID key/cert once one exists is the only change needed to make
// submitToZatca() do something real -- see its own comment below.
@Injectable()
export class ZatcaService {
  private readonly logger = new Logger(ZatcaService.name);
  private keyPair: { privateKey: KeyObject; publicKeyDer: Buffer } | null = null;

  constructor(private readonly config: ConfigService) {}

  private keysDir(): string {
    return this.config.get<string>('ZATCA_KEYS_DIR') ?? path.join(process.cwd(), '.zatca-keys');
  }

  // Lazily generates (once) or loads the local EC key pair used to sign
  // invoices. secp256k1 matches the curve ZATCA mandates for real CSID
  // keys, so this is drop-in compatible with a real cert's key material
  // later -- only the key SOURCE changes, not the signing code.
  private getKeyPair(): { privateKey: KeyObject; publicKeyDer: Buffer } {
    if (this.keyPair) return this.keyPair;

    const dir = this.keysDir();
    const privPath = path.join(dir, 'private-key.pem');
    const pubPath = path.join(dir, 'public-key.der');

    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      const privateKey = createPrivateKey(fs.readFileSync(privPath));
      const publicKeyDer = fs.readFileSync(pubPath);
      this.keyPair = { privateKey, publicKeyDer };
      return this.keyPair;
    }

    this.logger.warn(`لا يوجد مفتاح ZATCA محلي -- يتم توليد زوج مفاتيح جديد (بديل مؤقت لشهادة CSID حقيقية) في ${dir}`);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    fs.writeFileSync(pubPath, publicKeyDer);
    this.keyPair = { privateKey, publicKeyDer };
    return this.keyPair;
  }

  // ZATCA expects ONE chronological chain per location covering every
  // document it issues -- tax invoices AND credit notes together, not a
  // separate chain per document type. So "the previous document" has to be
  // whichever of Order/OrderReturn actually holds the higher
  // zatcaInvoiceCounter at this location, not just the last Order.
  private async getPreviousInvoiceHash(tx: Db, locationId: string): Promise<string> {
    const [prevOrder, prevReturn] = await Promise.all([
      tx.order.findFirst({
        where: { locationId, zatcaInvoiceCounter: { not: null } },
        orderBy: { zatcaInvoiceCounter: 'desc' },
        select: { zatcaInvoiceCounter: true, zatcaInvoiceHash: true },
      }),
      tx.orderReturn.findFirst({
        where: { order: { locationId }, zatcaInvoiceCounter: { not: null } },
        orderBy: { zatcaInvoiceCounter: 'desc' },
        select: { zatcaInvoiceCounter: true, zatcaInvoiceHash: true },
      }),
    ]);
    const latest = [prevOrder, prevReturn]
      .filter((r): r is { zatcaInvoiceCounter: number | null; zatcaInvoiceHash: string | null } => r !== null)
      .sort((a, b) => (b.zatcaInvoiceCounter ?? 0) - (a.zatcaInvoiceCounter ?? 0))[0];
    if (!latest?.zatcaInvoiceHash) return ZATCA_GENESIS_PIH;
    // PIH is base64 of the HEX STRING of the previous document's hash (not
    // raw bytes -- see the field comment on Order.zatcaPreviousInvoiceHash).
    return Buffer.from(Buffer.from(latest.zatcaInvoiceHash, 'base64').toString('hex')).toString('base64');
  }

  // Called from inside OrdersService.pay()'s own transaction, right after
  // the order is marked PAID -- generation happens in the same atomic step
  // as the sale itself, per docs/DECISIONS.md #3. Silently no-ops (leaves
  // zatcaSyncStatus at its default 'PENDING') when the location has no
  // vatNumber configured yet: a missing invoicing setting must never block
  // an actual cash sale from completing.
  async generateForOrder(tx: Db, orderId: string): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        lines: { include: { comboMeal: true, comboSelections: { include: { menuItem: true } } } },
        location: true,
        customer: true,
      },
    });
    if (!order.location.vatNumber) {
      this.logger.warn(`تخطّي توليد فاتورة ZATCA للطلب ${orderId} -- الموقع "${order.location.name}" بلا رقم ضريبي مُعدّ`);
      return;
    }

    const regularMenuItemIds = order.lines.map((l) => l.menuItemId).filter((id): id is string => id !== null);
    const menuItems = await tx.menuItem.findMany({ where: { id: { in: regularMenuItemIds } } });
    const nameById = new Map(menuItems.map((m) => [m.id, m.name]));
    const vatRate = Number(order.location.vatRate) / 100;
    const pricesIncludeVat = order.location.pricesIncludeVat;

    const invoiceLines = order.lines.map((line) => {
      const lineGross = round2(Number(line.unitPrice) * line.quantity);
      // pricesIncludeVat: unitPrice is the final (VAT-inclusive) price, so
      // the net amount ZATCA's LineExtensionAmount expects has to be backed
      // out of it instead of taken as-is -- lineTotal below stays the true
      // tax-exclusive net in both modes, matching OrdersService.create()'s
      // own extract-vs-add split.
      const lineNet = pricesIncludeVat ? round2(lineGross / (1 + vatRate)) : lineGross;
      const lineVat = pricesIncludeVat ? round2(lineGross - lineNet) : round2(lineGross * vatRate);
      // A combo line has no single menu item -- name it by the combo plus
      // its chosen composition so the printed invoice line is meaningful.
      const name = line.menuItemId
        ? (nameById.get(line.menuItemId) ?? line.menuItemId)
        : `${line.comboMeal!.name} (${line.comboSelections.map((s) => `${s.menuItem.name} × ${s.quantity}`).join('، ')})`;
      return {
        name,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
        lineTotal: lineNet,
        lineVat,
      };
    });

    const uuid = order.zatcaUuid ?? randomUUID();
    const issueDateTime = order.paidAt ?? new Date();

    // ZATCA chaining: this location's Nth reported document (ICV), and the
    // hash of its immediate predecessor at this SAME location (PIH) --
    // never across locations, since each location's vatNumber makes it its
    // own reporting unit, and never invoices-only (a credit note issued
    // after this order's last invoice is a real predecessor too -- see
    // getPreviousInvoiceHash). The increment happens inside the same
    // transaction pay() already runs generateForOrder in, so two orders at
    // the same location paid concurrently still get distinct, gap-free
    // counters (Postgres serializes the row update).
    const previousInvoiceHash = await this.getPreviousInvoiceHash(tx, order.locationId);
    const updatedLocation = await tx.location.update({
      where: { id: order.locationId },
      data: { zatcaInvoiceCounter: { increment: 1 } },
    });
    const invoiceCounter = updatedLocation.zatcaInvoiceCounter;
    // Net (tax-exclusive) LineExtensionAmount for the XML -- sums the
    // already-extracted invoiceLines above rather than order.subtotal
    // directly, since order.subtotal is the VAT-INCLUSIVE gross when
    // pricesIncludeVat is on and would otherwise inflate TaxExclusiveAmount.
    // Identical to order.subtotal when pricesIncludeVat is off (unchanged).
    const netSubtotal = round2(invoiceLines.reduce((sum, l) => sum + l.lineTotal, 0));

    const xml = buildInvoiceXml({
      invoiceId: order.id,
      uuid,
      issueDateTime,
      sellerName: order.location.name,
      vatNumber: order.location.vatNumber,
      subtotal: netSubtotal,
      discountTotal: Number(order.discountTotal),
      vatTotal: Number(order.vatTotal),
      grandTotal: Number(order.grandTotal),
      lines: invoiceLines,
      invoiceCounter,
      previousInvoiceHash,
      buyerName: order.customer?.name ?? undefined,
    });

    const { privateKey, publicKeyDer } = this.getKeyPair();
    const xmlBuffer = Buffer.from(xml, 'utf8');
    const hash = createHash('sha256').update(xmlBuffer).digest();
    const signature = createSign('sha256').update(xmlBuffer).end().sign(privateKey);

    const qrCode = buildQr({
      sellerName: order.location.name,
      vatNumber: order.location.vatNumber,
      timestamp: issueDateTime.toISOString(),
      invoiceTotal: Number(order.grandTotal).toFixed(2),
      vatTotal: Number(order.vatTotal).toFixed(2),
      invoiceHash: hash,
      signature,
      publicKey: publicKeyDer,
    });

    await tx.order.update({
      where: { id: orderId },
      data: {
        zatcaUuid: uuid,
        zatcaXml: xml,
        zatcaInvoiceHash: hash.toString('base64'),
        zatcaSignature: signature.toString('base64'),
        zatcaPublicKey: publicKeyDer.toString('base64'),
        zatcaQrCode: qrCode,
        zatcaSyncStatus: 'GENERATED',
        zatcaInvoiceCounter: invoiceCounter,
        zatcaPreviousInvoiceHash: previousInvoiceHash,
      },
    });
  }

  // Mirrors generateForOrder above, but for a customer return: ZATCA's
  // Credit Note (InvoiceTypeCode 381) referencing the original invoice via
  // BillingReference, signed the same way, chained into the SAME
  // per-location ICV/PIH sequence as ordinary invoices (see
  // getPreviousInvoiceHash). Called from inside ReturnsService's own
  // transaction, right after the OrderReturn row is created. Same silent
  // no-op as generateForOrder when the location has no vatNumber -- a
  // missing invoicing setting must never block an actual refund. Returns
  // whether a credit note was actually generated, so the caller can log an
  // accurate OrderReturnActivityLog entry (never claim ZATCA generation
  // that was silently skipped).
  async generateForReturn(tx: Db, returnId: string): Promise<boolean> {
    const ret = await tx.orderReturn.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        order: { include: { location: true, customer: true } },
        lines: { include: { orderLine: { include: { menuItem: true, comboMeal: true } } } },
      },
    });
    const location = ret.order.location;
    if (!location.vatNumber) {
      this.logger.warn(`تخطّي توليد إشعار دائن ZATCA للمرتجع ${returnId} -- الموقع "${location.name}" بلا رقم ضريبي مُعدّ`);
      return false;
    }

    // net/vat per line are the exact snapshot ReturnsService.computeLineRefund
    // persisted on OrderReturnLine -- never recomputed here, so the credit
    // note always agrees with the refund actually recorded/paid out.
    const invoiceLines = ret.lines.map((l) => ({
      name: l.orderLine.menuItem?.name ?? l.orderLine.comboMeal?.name ?? 'صنف',
      quantity: l.quantity,
      unitPrice: Number(l.orderLine.unitPrice),
      lineTotal: Number(l.netAmount),
      lineVat: Number(l.vatAmount),
    }));

    const uuid = ret.zatcaUuid ?? randomUUID();
    const issueDateTime = ret.createdAt;
    const previousInvoiceHash = await this.getPreviousInvoiceHash(tx, ret.order.locationId);
    const updatedLocation = await tx.location.update({
      where: { id: ret.order.locationId },
      data: { zatcaInvoiceCounter: { increment: 1 } },
    });
    const invoiceCounter = updatedLocation.zatcaInvoiceCounter;
    const netSubtotal = round2(invoiceLines.reduce((sum, l) => sum + l.lineTotal, 0));
    const vatTotal = round2(invoiceLines.reduce((sum, l) => sum + l.lineVat, 0));

    const xml = buildInvoiceXml({
      invoiceId: ret.id,
      uuid,
      issueDateTime,
      sellerName: location.name,
      vatNumber: location.vatNumber,
      // Already net of any discount share (see computeLineRefund) -- no
      // separate discountTotal to apply again on top.
      subtotal: netSubtotal,
      discountTotal: 0,
      vatTotal,
      grandTotal: Number(ret.refundTotal),
      lines: invoiceLines,
      invoiceCounter,
      previousInvoiceHash,
      buyerName: ret.order.customer?.name ?? undefined,
      invoiceTypeCode: 381,
      billingReferenceId: ret.order.id,
    });

    const { privateKey, publicKeyDer } = this.getKeyPair();
    const xmlBuffer = Buffer.from(xml, 'utf8');
    const hash = createHash('sha256').update(xmlBuffer).digest();
    const signature = createSign('sha256').update(xmlBuffer).end().sign(privateKey);

    const qrCode = buildQr({
      sellerName: location.name,
      vatNumber: location.vatNumber,
      timestamp: issueDateTime.toISOString(),
      invoiceTotal: Number(ret.refundTotal).toFixed(2),
      vatTotal: vatTotal.toFixed(2),
      invoiceHash: hash,
      signature,
      publicKey: publicKeyDer,
    });

    await tx.orderReturn.update({
      where: { id: returnId },
      data: {
        zatcaUuid: uuid,
        zatcaXml: xml,
        zatcaInvoiceHash: hash.toString('base64'),
        zatcaSignature: signature.toString('base64'),
        zatcaPublicKey: publicKeyDer.toString('base64'),
        zatcaQrCode: qrCode,
        zatcaSyncStatus: 'GENERATED',
        zatcaInvoiceCounter: invoiceCounter,
        zatcaPreviousInvoiceHash: previousInvoiceHash,
      },
    });
    return true;
  }

  // Would report the signed invoice to ZATCA's actual Fatoora platform
  // (simplified invoices are REPORTED within 24h, not cleared in real
  // time). Real integration needs: (1) a compliance/production CSID
  // obtained through ZATCA's onboarding (their portal + an OTP -- there is
  // no way to script around that from here), (2) that CSID's cert +
  // private key swapped in for the local stand-in above, (3) the actual
  // Reporting API base URL. None of that is available in this
  // environment, so this throws honestly instead of faking a SYNCED
  // status the platform never actually granted.
  async submitToZatca(orderId: string): Promise<never> {
    const baseUrl = this.config.get<string>('ZATCA_API_BASE_URL');
    if (!baseUrl) {
      throw new ServiceUnavailableException(
        'لا تتوفر بيانات اعتماد ZATCA حقيقية في هذه البيئة (تحتاج CSID مُصدرة فعليًا من بوابة فاتورة) -- ' +
          'الفاتورة مولّدة وموقّعة محليًا بالفعل (راجع GET /orders/:id لحقول zatca*) لكنها لم تُرفع لمنصة فاتورة.',
      );
    }
    // Real submission call goes here once ZATCA_API_BASE_URL/credentials
    // exist -- intentionally unimplemented rather than half-faked.
    throw new ServiceUnavailableException('تكامل الرفع الفعلي لمنصة فاتورة غير مُنفَّذ بعد.');
  }
}
