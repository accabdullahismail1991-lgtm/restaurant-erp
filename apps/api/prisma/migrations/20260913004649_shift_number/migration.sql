-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "lastShiftNumber" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "shiftNumber" INTEGER;
