// Builds a UBL 2.1 Invoice document for a ZATCA Simplified Tax Invoice
// (B2C -- the normal case for a restaurant POS sale). This is a good-faith
// structural implementation covering the elements ZATCA's own guides mark
// as mandatory; it is NOT validated against ZATCA's full XSD/Schematron
// rule set (that requires their published schema files and, ultimately,
// their sandbox to actually clear/report against -- see the module's
// README for why that step is deferred). Treat this as "correct shape,
// unverified against the government's exact rule set" rather than
// production-certified.

export interface InvoiceLineInput {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  lineVat: number;
}

export interface InvoiceXmlInput {
  invoiceId: string;
  uuid: string;
  issueDateTime: Date;
  sellerName: string;
  vatNumber: string;
  subtotal: number;
  discountTotal: number;
  vatTotal: number;
  grandTotal: number;
  lines: InvoiceLineInput[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const money = (n: number) => n.toFixed(2);

export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const issueDate = input.issueDateTime.toISOString().slice(0, 10);
  const issueTime = input.issueDateTime.toISOString().slice(11, 19);
  const taxExclusive = input.subtotal - input.discountTotal;

  const lines = input.lines
    .map(
      (line, i) => `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="EA">${line.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${money(line.lineTotal)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${money(line.lineVat)}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(line.name)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${money(line.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(input.invoiceId)}</cbc:ID>
  <cbc:UUID>${input.uuid}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(input.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(input.sellerName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${money(input.vatTotal)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${money(input.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${money(taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${money(input.grandTotal)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">${money(input.discountTotal)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="SAR">${money(input.grandTotal)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>
`;
}
