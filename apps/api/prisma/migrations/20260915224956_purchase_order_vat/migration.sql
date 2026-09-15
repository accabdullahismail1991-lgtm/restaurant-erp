-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vatTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "taxType" "TaxType" NOT NULL DEFAULT 'STANDARD';
