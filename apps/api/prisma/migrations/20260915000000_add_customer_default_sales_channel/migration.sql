-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "defaultSalesChannelId" TEXT;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_defaultSalesChannelId_fkey" FOREIGN KEY ("defaultSalesChannelId") REFERENCES "SalesChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
