-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "zatcaInvoiceCounter" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "zatcaInvoiceCounter" INTEGER,
ADD COLUMN     "zatcaPreviousInvoiceHash" TEXT;
