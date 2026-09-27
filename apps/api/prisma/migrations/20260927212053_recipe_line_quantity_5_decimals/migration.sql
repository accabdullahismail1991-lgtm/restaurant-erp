/*
  Warnings:

  - You are about to alter the column `quantity` on the `RecipeLine` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,3)` to `Decimal(12,5)`.

*/
-- AlterTable
ALTER TABLE "RecipeLine" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,5);
