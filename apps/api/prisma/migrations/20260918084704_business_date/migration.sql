-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "fiscalYearEndDay" INTEGER,
ADD COLUMN     "fiscalYearEndMonth" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "businessDate" DATE;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "businessDate" DATE;
