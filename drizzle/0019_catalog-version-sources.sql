ALTER TABLE "catalog_summary" ADD COLUMN "lst_only_version_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_summary" ADD COLUMN "shared_version_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_summary" ADD COLUMN "releases_only_version_count" integer DEFAULT 0 NOT NULL;