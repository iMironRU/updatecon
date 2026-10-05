ALTER TABLE "version_meta" ADD COLUMN "files" jsonb;--> statement-breakpoint
ALTER TABLE "version_meta" ADD COLUMN "files_nick" text;--> statement-breakpoint
ALTER TABLE "version_meta" ADD COLUMN "files_fetched_at" timestamp with time zone;