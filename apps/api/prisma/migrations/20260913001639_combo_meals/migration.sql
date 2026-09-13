-- DropForeignKey
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_menuItemId_fkey";

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "comboMealId" TEXT,
ALTER COLUMN "menuItemId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ComboMeal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComboMeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboSlot" (
    "id" TEXT NOT NULL,
    "comboMealId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 1,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ComboSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboSlotOption" (
    "id" TEXT NOT NULL,
    "comboSlotId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "extraPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ComboSlotOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboSelection" (
    "id" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "comboSlotId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "extraPrice" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "ComboSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComboSlotOption_comboSlotId_menuItemId_key" ON "ComboSlotOption"("comboSlotId", "menuItemId");

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_comboMealId_fkey" FOREIGN KEY ("comboMealId") REFERENCES "ComboMeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboSlot" ADD CONSTRAINT "ComboSlot_comboMealId_fkey" FOREIGN KEY ("comboMealId") REFERENCES "ComboMeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboSlotOption" ADD CONSTRAINT "ComboSlotOption_comboSlotId_fkey" FOREIGN KEY ("comboSlotId") REFERENCES "ComboSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboSlotOption" ADD CONSTRAINT "ComboSlotOption_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboSelection" ADD CONSTRAINT "ComboSelection_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboSelection" ADD CONSTRAINT "ComboSelection_comboSlotId_fkey" FOREIGN KEY ("comboSlotId") REFERENCES "ComboSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboSelection" ADD CONSTRAINT "ComboSelection_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
