-- CreateEnum
CREATE TYPE "TaxType" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');

-- AlterTable
ALTER TABLE "ComboMeal" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "autoCloseCutoffHour" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "autoCloseEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "taxType" "TaxType" NOT NULL DEFAULT 'STANDARD';

-- CreateTable
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "autoClosed" BOOLEAN NOT NULL DEFAULT false,
    "shiftsCount" INTEGER NOT NULL,
    "totalRevenue" DECIMAL(12,2) NOT NULL,
    "totalVariance" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DayClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitOfMeasure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitOfMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DayClose_locationId_businessDate_key" ON "DayClose"("locationId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "UnitOfMeasure_code_key" ON "UnitOfMeasure"("code");

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
