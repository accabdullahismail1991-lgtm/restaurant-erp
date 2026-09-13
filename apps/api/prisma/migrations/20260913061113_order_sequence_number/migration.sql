-- AddColumn (autoincrement, backfilled by Postgres SERIAL semantics for existing rows too)
ALTER TABLE "Order" ADD COLUMN "sequenceNumber" SERIAL;

-- CreateIndex
CREATE UNIQUE INDEX "Order_sequenceNumber_key" ON "Order"("sequenceNumber");
