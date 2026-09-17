-- AlterTable
ALTER TABLE "OrderReturn" ADD COLUMN     "zatcaInvoiceCounter" INTEGER,
ADD COLUMN     "zatcaInvoiceHash" TEXT,
ADD COLUMN     "zatcaPreviousInvoiceHash" TEXT,
ADD COLUMN     "zatcaPublicKey" TEXT,
ADD COLUMN     "zatcaQrCode" TEXT,
ADD COLUMN     "zatcaSignature" TEXT,
ADD COLUMN     "zatcaSyncStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "zatcaUuid" TEXT,
ADD COLUMN     "zatcaXml" TEXT;

-- AlterTable
ALTER TABLE "OrderReturnLine" ADD COLUMN     "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderReturnActivityLog" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderReturnActivityLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "OrderReturnActivityLog" ADD CONSTRAINT "OrderReturnActivityLog_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "OrderReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReturnActivityLog" ADD CONSTRAINT "OrderReturnActivityLog_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
