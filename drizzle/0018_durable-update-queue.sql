ALTER TABLE "release_version_resources" ADD COLUMN "metadata_checked_at" timestamp with time zone;--> statement-breakpoint
UPDATE "release_version_resources"
SET "metadata_checked_at" = "updated_at"
WHERE "href" LIKE '/version_file?%'
  AND ("file_name" IS NOT NULL OR "file_size_bytes" IS NOT NULL OR "published_at" IS NOT NULL OR "sha512" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "resume_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;
