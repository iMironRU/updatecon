ALTER TABLE "update_jobs" ADD COLUMN "progress_current" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "progress_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "progress_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "pages_current" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "pages_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "active_workers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "max_workers" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "requests_completed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "update_jobs" ADD COLUMN "request_retries" integer DEFAULT 0 NOT NULL;