-- CreateEnum
CREATE TYPE "inbound_email_provider" AS ENUM ('mailgun', 'manual');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('processing', 'needs_review', 'unpaid', 'paid', 'rejected');

-- CreateEnum
CREATE TYPE "extraction_status" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('invoice', 'credit_note', 'proforma', 'statement', 'other');

-- CreateEnum
CREATE TYPE "invoice_category" AS ENUM ('fuel', 'ground_handling', 'airport_charges', 'navigation', 'catering', 'maintenance', 'crew', 'other');

-- CreateEnum
CREATE TYPE "rejection_reason" AS ENUM ('duplicate', 'not_invoice', 'disputed', 'other');

-- CreateEnum
CREATE TYPE "invoice_event_type" AS ENUM ('received', 'extracted', 'extraction_failed', 'edited', 'approved', 'rejected', 'paid', 'payment_undone', 'reopened', 'reextracted', 'vendor_linked', 'bank_account_trusted');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_emails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "inbound_email_provider" NOT NULL,
    "message_id" TEXT,
    "from_address" TEXT,
    "sender" TEXT,
    "recipient" TEXT,
    "subject" TEXT,
    "body_text" TEXT,
    "headers" JSONB,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "default_payment_terms_days" INTEGER,
    "bank_accounts" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inbound_email_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "page_count" INTEGER,
    "status" "invoice_status" NOT NULL DEFAULT 'processing',
    "extraction_status" "extraction_status" NOT NULL DEFAULT 'pending',
    "extraction_error" TEXT,
    "extraction_raw" JSONB,
    "extraction_model" TEXT,
    "extraction_prompt_version" TEXT,
    "extracted_at" TIMESTAMPTZ(3),
    "document_type" "document_type",
    "vendor_id" UUID,
    "vendor_name" TEXT,
    "vendor_tax_id" TEXT,
    "bill_to_name" TEXT,
    "invoice_number" TEXT,
    "invoice_date" DATE,
    "service_date" DATE,
    "due_date" DATE,
    "dispute_deadline" DATE,
    "payment_terms_text" TEXT,
    "payment_terms_days" INTEGER,
    "dispute_window_days" INTEGER,
    "category" "invoice_category",
    "description" TEXT,
    "airport_icao" TEXT,
    "airport_iata" TEXT,
    "location_text" TEXT,
    "aircraft_registration" TEXT,
    "flight_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currency" CHAR(3),
    "subtotal_amount" DECIMAL(18,4),
    "tax_amount" DECIMAL(18,4),
    "total_amount" DECIMAL(18,4),
    "amount_due" DECIMAL(18,4),
    "amount_due_currency" CHAR(3),
    "line_items" JSONB NOT NULL DEFAULT '[]',
    "bank_details" JSONB,
    "notes" TEXT,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "paid_at" DATE,
    "paid_by_id" UUID,
    "payment_reference" TEXT,
    "payment_note" TEXT,
    "rejected_at" TIMESTAMPTZ(3),
    "rejected_by_id" UUID,
    "rejection_reason" "rejection_reason",
    "rejection_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "user_id" UUID,
    "type" "invoice_event_type" NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_emails_message_id_key" ON "inbound_emails"("message_id");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoices_due_date_idx" ON "invoices"("due_date");

-- CreateIndex
CREATE INDEX "invoices_vendor_id_idx" ON "invoices"("vendor_id");

-- CreateIndex
CREATE INDEX "invoices_vendor_id_invoice_number_idx" ON "invoices"("vendor_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoices_file_sha256_idx" ON "invoices"("file_sha256");

-- CreateIndex
CREATE INDEX "invoices_inbound_email_id_idx" ON "invoices"("inbound_email_id");

-- CreateIndex
CREATE INDEX "invoice_events_invoice_id_created_at_idx" ON "invoice_events"("invoice_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_inbound_email_id_fkey" FOREIGN KEY ("inbound_email_id") REFERENCES "inbound_emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Manual additions (not expressible in schema.prisma) ─────────────────────

-- users.email is stored lowercase (SPEC §5).
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email"));

-- invoice_events is append-only (SPEC §5): block UPDATE and DELETE.
CREATE FUNCTION "invoice_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice_events is append-only (% blocked)', TG_OP;
END;
$$;

CREATE TRIGGER "invoice_events_append_only"
  BEFORE UPDATE OR DELETE ON "invoice_events"
  FOR EACH ROW EXECUTE FUNCTION "invoice_events_append_only"();
