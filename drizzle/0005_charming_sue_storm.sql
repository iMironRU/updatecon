CREATE TABLE IF NOT EXISTS "account_project_access" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"status" text DEFAULT 'unavailable' NOT NULL,
	"href" text,
	"last_error" text DEFAULT '' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "its_accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"login" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"last_status" text DEFAULT 'never' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_project_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"version" text NOT NULL,
	"release_date" date,
	"min_platform" text,
	"file_size_bytes" integer,
	"download_href" text,
	"source_account_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_projects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identity_key" text NOT NULL,
	"href" text,
	"display_name" text NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"region" text,
	"latest_version" text,
	"latest_date" date,
	"next_release_version" text,
	"next_release_planned_date" text,
	"next_release_plan_updated" date,
	"preview_version" text,
	"preview_date" date,
	"config_id" integer,
	"mapping_mode" text DEFAULT 'unmatched' NOT NULL,
	"mapping_confidence" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "account_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_project_access" ADD CONSTRAINT "account_project_access_account_id_its_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."its_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_project_access" ADD CONSTRAINT "account_project_access_project_id_release_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."release_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_project_versions" ADD CONSTRAINT "release_project_versions_project_id_release_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."release_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_project_versions" ADD CONSTRAINT "release_project_versions_source_account_id_its_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."its_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "release_projects" ADD CONSTRAINT "release_projects_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_project_access_uq" ON "account_project_access" USING btree ("account_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_project_access_status_idx" ON "account_project_access" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "its_accounts_login_uq" ON "its_accounts" USING btree ("login");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "its_accounts_enabled_priority_idx" ON "its_accounts" USING btree ("enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_project_versions_uq" ON "release_project_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_project_versions_project_idx" ON "release_project_versions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_projects_identity_uq" ON "release_projects" USING btree ("identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_projects_href_uq" ON "release_projects" USING btree ("href");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_projects_config_idx" ON "release_projects" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_projects_group_idx" ON "release_projects" USING btree ("group_name");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_account_id_its_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."its_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
