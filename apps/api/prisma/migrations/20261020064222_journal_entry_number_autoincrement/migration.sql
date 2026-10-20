-- AlterTable
CREATE SEQUENCE journalentry_entrynumber_seq;
ALTER TABLE "JournalEntry" ALTER COLUMN "entryNumber" SET DEFAULT nextval('journalentry_entrynumber_seq');
ALTER SEQUENCE journalentry_entrynumber_seq OWNED BY "JournalEntry"."entryNumber";
