-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "note" TEXT,
    "fileName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileData" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);
