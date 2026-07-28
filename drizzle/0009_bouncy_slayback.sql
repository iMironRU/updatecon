ALTER TABLE "configurations" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "exclude_from_updates" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "display_name_override" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "vendor_override" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "group_name_override" text;--> statement-breakpoint
ALTER TABLE "configurations" ADD COLUMN "region_override" text;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "release_date_override" date;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "min_platform_override" text;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "recommended_platform_override" text;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "file_size_bytes_override" integer;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "exclude_from_updates" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "display_name_override" text;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "group_name_override" text;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "title_override" text;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "href_override" text;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "file_size_bytes_override" integer;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "published_at_override" date;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "sha512_override" text;