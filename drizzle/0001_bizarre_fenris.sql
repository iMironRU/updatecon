CREATE TABLE IF NOT EXISTS "version_meta" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"config_id" integer NOT NULL,
	"version" text NOT NULL,
	"release_date" date,
	"min_platform" text,
	"source" text DEFAULT 'releases' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "releases_href" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "version_meta" ADD CONSTRAINT "version_meta_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "version_meta_uq" ON "version_meta" USING btree ("config_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "version_meta_config_idx" ON "version_meta" USING btree ("config_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "configurations_releases_href_uq" ON "configurations" USING btree ("releases_href");