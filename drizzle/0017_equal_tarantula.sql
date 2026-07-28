CREATE TABLE "catalog_summary" (
	"catalog_key" text PRIMARY KEY NOT NULL,
	"config_id" integer,
	"project_id" integer,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"releases_href" text,
	"group_name" text DEFAULT '' NOT NULL,
	"region" text,
	"next_release_version" text,
	"next_release_planned_date" text,
	"next_release_plan_updated" date,
	"latest_version" text,
	"latest_date" date,
	"latest_platform" text,
	"latest_recommended_platform" text,
	"version_count" integer DEFAULT 0 NOT NULL,
	"avg_days" integer,
	"has_graph" boolean DEFAULT false NOT NULL,
	"mapping_status" text DEFAULT 'unmatched' NOT NULL,
	"transition_mode" text DEFAULT 'unknown' NOT NULL,
	"available_accounts" integer DEFAULT 0 NOT NULL,
	"available_account_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "project_catalog_signature" text;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "project_page_hash" text;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "project_page_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "catalog_summary_config_idx" ON "catalog_summary" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "catalog_summary_project_idx" ON "catalog_summary" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "catalog_summary_latest_date_idx" ON "catalog_summary" USING btree ("latest_date");--> statement-breakpoint
CREATE INDEX "catalog_summary_group_idx" ON "catalog_summary" USING btree ("group_name");--> statement-breakpoint
CREATE INDEX "catalog_summary_region_idx" ON "catalog_summary" USING btree ("region");--> statement-breakpoint
CREATE INDEX "account_project_access_project_status_idx" ON "account_project_access" USING btree ("project_id","status","account_id");--> statement-breakpoint
CREATE INDEX "release_project_versions_visible_latest_idx" ON "release_project_versions" USING btree ("project_id","is_hidden","is_test","release_date");--> statement-breakpoint
CREATE INDEX "release_projects_page_check_idx" ON "release_projects" USING btree ("exclude_from_updates","project_page_checked_at");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "catalog_summary_search_trgm_idx" ON "catalog_summary" USING gin (
  (lower(coalesce("display_name", '') || ' ' || coalesce("name", '') || ' ' || coalesce("vendor", ''))) gin_trgm_ops
);
