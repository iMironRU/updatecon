CREATE TABLE IF NOT EXISTS "patches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"config_id" integer NOT NULL,
	"version" text NOT NULL,
	"uuid" text NOT NULL,
	"title" text,
	"patch_date" date,
	"download_key" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "group_name" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "next_release_version" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "next_release_planned_date" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "next_release_plan_updated" date;--> statement-breakpoint
ALTER TABLE "version_meta" ADD COLUMN "file_size_bytes" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "patches" ADD CONSTRAINT "patches_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patches_uuid_uq" ON "patches" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patches_config_version_idx" ON "patches" USING btree ("config_id","version");