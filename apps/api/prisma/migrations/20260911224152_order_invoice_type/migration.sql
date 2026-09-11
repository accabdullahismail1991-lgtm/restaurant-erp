-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('CASH', 'CREDIT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "invoiceType" "InvoiceType" NOT NULL DEFAULT 'CASH';
