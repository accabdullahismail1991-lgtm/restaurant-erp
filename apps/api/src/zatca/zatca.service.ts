import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, generateKeyPairSync, createPrivateKey, createSign, createHash, KeyObject } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { buildInvoiceXml } from './invoice-xml.util';
import { buildQr } from './qr.util';

const VAT_RATE = 0.15;
const round2 = (n: number) => Math.round(n * 100) / 100;

// base64(hex(SHA-256("0"))) -- ZATCA's published Previous Invoice Hash
// value for the very first invoice in a chain (there is no real
// predecessor to reference yet). Verified by direct computation, not
// copied blind: crypto.createHash('sha256').update('0').digest('hex')
// then Buffer.from(thatHexString).toString('base64').
const ZATCA_GENESIS_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

type Db = Pick<PrismaService, 'order' | 'menuItem' | 'location'>;

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

  // Called from inside OrdersService.pay()'s own transaction, right after
  // the order is marked PAID -- generation happens in the same atomic step
  // as the sale itself, per docs/DECISIONS.md #3. Silently no-ops (leaves
  // zatcaSyncStatus at its default 'PENDING') when the location has no
  // vatNumber configured yet: a missing invoicing setting must never block
  // an actual cash sale from completing.
  async generateForOrder(tx: Db, orderId: string): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true, location: true, customer: true },
    });
    if (!order.location.vatNumber) {
      this.logger.warn(`تخطّي توليد فاتورة ZATCA للطلب ${orderId} -- الموقع "${order.location.name}" بلا رقم ضريبي مُعدّ`);
      return;
    }

    const menuItems = await tx.menuItem.findMany({ where: { id: { in: order.lines.map((l) => l.menuItemId) } } });
    const nameById = new Map(menuItems.map((m) => [m.id, m.name]));

    const invoiceLines = order.lines.map((line) => {
      const lineSubtotal = round2(Number(line.unitPrice) * line.quantity);
      return {
        name: nameById.get(line.menuItemId) ?? line.menuItemId,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
        lineTotal: lineSubtotal,
        lineVat: round2(lineSubtotal * VAT_RATE),
      };
    });

    const uuid = order.zatcaUuid ?? randomUUID();
    const issueDateTime = order.paidAt ?? new Date();

    // ZATCA chaining: this location's Nth reported invoice (ICV), and the
    // hash of its immediate predecessor at this SAME location (PIH) --
    // never across locations, since each location's vatNumber makes it its
    // own reporting unit. The increment happens inside the same
    // transaction pay() already runs generateForOrder in, so two orders at
    // the same location paid concurrently still get distinct, gap-free
    // counters (Postgres serializes the row update).
    const previousInvoice = await tx.order.findFirst({
      where: { locationId: order.locationId, zatcaInvoiceCounter: { not: null } },
      orderBy: { zatcaInvoiceCounter: 'desc' },
      select: { zatcaInvoiceHash: true },
    });
    const previousInvoiceHash = previousInvoice?.zatcaInvoiceHash
      ? Buffer.from(Buffer.from(previousInvoice.zatcaInvoiceHash, 'base64').toString('hex')).toString('base64')
      : ZATCA_GENESIS_PIH;
    const updatedLocation = await tx.location.update({
      where: { id: order.locationId },
      data: { zatcaInvoiceCounter: { increment: 1 } },
    });
    const invoiceCounter = updatedLocation.zatcaInvoiceCounter;

    const xml = buildInvoiceXml({
      invoiceId: order.id,
      uuid,
      issueDateTime,
      sellerName: order.location.name,
      vatNumber: order.location.vatNumber,
      subtotal: Number(order.subtotal),
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
