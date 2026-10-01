ALTER TABLE "release_projects" ADD COLUMN "lts_version" text;--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "lts_until" date;