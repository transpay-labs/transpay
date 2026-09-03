CREATE TYPE "public"."corridor" AS ENUM('PHP', 'VND');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'quoted', 'confirmed', 'recipient_added', 'awaiting_deposit', 'settlement_ready', 'settling', 'settled', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('submitted', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "deposit_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"deposit_reference" text NOT NULL,
	"expected_usd_amount" numeric(20, 7) NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor" text NOT NULL,
	"external_ref" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"bank_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_counters" (
	"corridor" "corridor" NOT NULL,
	"day" date NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reference_counters_corridor_day_pk" PRIMARY KEY("corridor","day")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"signed_xdr" text NOT NULL,
	"status" "settlement_status" DEFAULT 'submitted' NOT NULL,
	"source_account" text NOT NULL,
	"destination_account" text NOT NULL,
	"asset_code" text NOT NULL,
	"asset_issuer" text NOT NULL,
	"amount" numeric(20, 7) NOT NULL,
	"memo" text NOT NULL,
	"ledger_seq" integer,
	"horizon_response" jsonb,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"failure_reason" text,
	CONSTRAINT "memo_fits" CHECK (octet_length("settlements"."memo") <= 28)
);
--> statement-breakpoint
CREATE TABLE "transfer_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_id" text NOT NULL,
	"access_token" text NOT NULL,
	"corridor" "corridor" NOT NULL,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"usd_amount" numeric(20, 7) NOT NULL,
	"php_estimate" numeric(20, 2),
	"fx_rate" numeric(20, 7),
	"fee_usd" numeric(20, 7),
	"quoted_at" timestamp with time zone,
	"quote_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_id_format" CHECK ("transfer_orders"."reference_id" ~ '^TP-(PHP|VND)-[0-9]{8}-[0-9]{4}$'),
	CONSTRAINT "reference_id_fits_memo" CHECK (octet_length("transfer_orders"."reference_id") <= 28),
	CONSTRAINT "usd_amount_positive" CHECK ("transfer_orders"."usd_amount" > 0),
	CONSTRAINT "reference_id_matches_corridor" CHECK ("transfer_orders"."reference_id" LIKE 'TP-' || "transfer_orders"."corridor"::text || '-%')
);
--> statement-breakpoint
ALTER TABLE "deposit_references" ADD CONSTRAINT "deposit_references_order_id_transfer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_transfer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_order_id_transfer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_order_id_transfer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."transfer_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_references_reference_key" ON "deposit_references" USING btree ("deposit_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_references_order_id_key" ON "deposit_references" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_events_order_id_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recipients_order_id_key" ON "recipients" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_tx_hash_key" ON "settlements" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_active_order_key" ON "settlements" USING btree ("order_id") WHERE status <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_orders_reference_id_key" ON "transfer_orders" USING btree ("reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_orders_access_token_key" ON "transfer_orders" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "transfer_orders_status_idx" ON "transfer_orders" USING btree ("status");