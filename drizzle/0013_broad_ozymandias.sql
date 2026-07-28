ALTER TABLE "its_accounts" ADD COLUMN "request_concurrency" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "resources_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "resources_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "resources_sync_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "resources_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "resources_last_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "release_project_versions"
SET "resources_sync_status" = CASE WHEN "resources_synced_at" IS NULL THEN 'pending' ELSE 'ok' END,
    "resources_last_attempt_at" = "resources_synced_at";--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "update_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "queue_pending" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "queue_retry" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "estimated_finish_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "release_project_versions_sync_queue_idx" ON "release_project_versions" USING btree ("resources_sync_status","resources_next_attempt_at");
