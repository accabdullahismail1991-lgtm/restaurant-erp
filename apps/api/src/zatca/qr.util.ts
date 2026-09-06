// ZATCA Phase 2 QR payload: a sequence of TLV (Tag-Length-Value) entries,
// base64-encoded as a whole. Each entry is [1-byte tag][1-byte length][value
// bytes] -- tags 1-5 carry UTF-8 text, tags 6-8 carry raw binary (the hash,
// the signature, and the public key respectively), never re-encoded as
// text first. This matches the structure any ZATCA-compliant QR reader
// (including the official app) expects to scan off a receipt.
//
// Tag reference (the subset needed for a Simplified Tax Invoice):
//   1 seller name            5 VAT total
//   2 VAT registration no.   6 invoice XML hash (raw SHA-256 bytes)
//   3 invoice timestamp      7 ECDSA signature (raw bytes)
//   4 invoice total (w/ VAT) 8 public key (raw DER SPKI bytes)
// Tag 9 (a CA-issued stamp signature over tags 1-8) only applies once a
// real ZATCA-issued CSID certificate is in play -- omitted here since our
// key pair is a local stand-in (see ZatcaService).

export interface QrFields {
  sellerName: string;
  vatNumber: string;
  timestamp: string; // ISO 8601
  invoiceTotal: string;
  vatTotal: string;
  invoiceHash: Buffer;
  signature: Buffer;
  publicKey: Buffer;
}

function tlv(tag: number, value: Buffer): Buffer {
  if (value.length > 255) throw new Error(`قيمة TLV للحقل ${tag} أطول من 255 بايت`);
  return Buffer.concat([Buffer.from([tag]), Buffer.from([value.length]), value]);
}

export function buildQr(fields: QrFields): string {
  const entries = [
    tlv(1, Buffer.from(fields.sellerName, 'utf8')),
    tlv(2, Buffer.from(fields.vatNumber, 'utf8')),
    tlv(3, Buffer.from(fields.timestamp, 'utf8')),
    tlv(4, Buffer.from(fields.invoiceTotal, 'utf8')),
    tlv(5, Buffer.from(fields.vatTotal, 'utf8')),
    tlv(6, fields.invoiceHash),
    tlv(7, fields.signature),
    tlv(8, fields.publicKey),
  ];
  return Buffer.concat(entries).toString('base64');
}

// Decodes a QR payload back into its raw tag -> bytes map, for verification
// (used by tests and could back a "scan to verify" admin tool later) --
// mirrors exactly what a real QR-reading client does, so a round-trip
// check here is a genuine structural proof, not an assertion against our
// own encoder's internals.
export function decodeQr(base64: string): Map<number, Buffer> {
  const buf = Buffer.from(base64, 'base64');
  const result = new Map<number, Buffer>();
  let offset = 0;
  while (offset < buf.length) {
    const tag = buf[offset];
    const length = buf[offset + 1];
    const value = buf.subarray(offset + 2, offset + 2 + length);
    result.set(tag, value);
    offset += 2 + length;
  }
  return result;
}
