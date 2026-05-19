CREATE TABLE IF NOT EXISTS "configurations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'lst' NOT NULL,
	"file_sha256" text NOT NULL,
	"file_bytes" integer DEFAULT 0 NOT NULL,
	"configs_found" integer DEFAULT 0 NOT NULL,
	"edges_upserted" integer DEFAULT 0 NOT NULL,
	"edges_unchanged" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "update_edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"config_id" integer NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"edition" integer NOT NULL,
	"cfu_path" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"raw_json" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "update_edges" ADD CONSTRAINT "update_edges_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "configurations_name_uq" ON "configurations" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_runs_sha_idx" ON "import_runs" USING btree ("source","file_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "update_edges_edge_uq" ON "update_edges" USING btree ("config_id","from_version","to_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "update_edges_from_idx" ON "update_edges" USING btree ("config_id","edition","from_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "update_edges_to_idx" ON "update_edges" USING btree ("config_id","edition","to_version");