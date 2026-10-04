-- CreateEnum
CREATE TYPE "due_date_source" AS ENUM ('printed', 'terms', 'vendor_default', 'manual');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "due_date_source" "due_date_source";

-- Before T04 every stored due date came from the extraction, i.e. was printed on the invoice.
UPDATE "invoices" SET "due_date_source" = 'printed' WHERE "due_date" IS NOT NULL;
