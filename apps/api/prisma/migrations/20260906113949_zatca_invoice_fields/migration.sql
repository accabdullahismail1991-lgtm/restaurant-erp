-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "vatNumber" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "zatcaInvoiceHash" TEXT,
ADD COLUMN     "zatcaPublicKey" TEXT,
ADD COLUMN     "zatcaXml" TEXT;
