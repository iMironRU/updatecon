CREATE TABLE IF NOT EXISTS "exchange_formats" (
	"line" text NOT NULL,
	"version" text NOT NULL,
	"config_id" integer,
	"declared" text[],
	"packages" text[],
	CONSTRAINT "exchange_formats_line_version_pk" PRIMARY KEY("line","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exchanges" (
	"id" integer PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"mechanism" text NOT NULL,
	"from_product" text NOT NULL,
	"from_edition" text,
	"from_label" text NOT NULL,
	"from_config_id" integer,
	"to_product" text NOT NULL,
	"to_edition" text,
	"to_label" text NOT NULL,
	"to_config_id" integer,
	"exchange_plan" text,
	"task" text,
	"direction" text,
	"actual" text,
	"format_versions" text[],
	"objects" jsonb,
	"sources" text[],
	"shipped_in" jsonb,
	"urls" jsonb,
	"notes" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exchange_formats" ADD CONSTRAINT "exchange_formats_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_from_config_id_configurations_id_fk" FOREIGN KEY ("from_config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_to_config_id_configurations_id_fk" FOREIGN KEY ("to_config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchanges_from_idx" ON "exchanges" USING btree ("from_config_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exchanges_to_idx" ON "exchanges" USING btree ("to_config_id");