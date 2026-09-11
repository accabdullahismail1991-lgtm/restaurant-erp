-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "lastOrderSequence" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DailyInvoiceCounter" (
    "locationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyInvoiceCounter_pkey" PRIMARY KEY ("locationId","date")
);
