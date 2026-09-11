-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "invoiceFooterNote" TEXT,
ADD COLUMN     "invoiceHeaderNote" TEXT,
ADD COLUMN     "logoData" BYTEA,
ADD COLUMN     "logoMimeType" TEXT;
