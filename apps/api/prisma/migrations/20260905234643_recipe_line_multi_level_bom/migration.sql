-- DropForeignKey
ALTER TABLE "RecipeLine" DROP CONSTRAINT "RecipeLine_menuItemId_fkey";

-- AlterTable
ALTER TABLE "RecipeLine" ADD COLUMN     "parentIngredientId" TEXT,
ALTER COLUMN "menuItemId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_parentIngredientId_fkey" FOREIGN KEY ("parentIngredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
