CREATE TABLE "update_job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"stage" text DEFAULT 'system' NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stage" text DEFAULT 'starting' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "release_projects" ADD COLUMN "transition_mode" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "update_job_events" ADD CONSTRAINT "update_job_events_job_id_update_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."update_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "update_job_events_job_idx" ON "update_job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "update_jobs_status_started_idx" ON "update_jobs" USING btree ("status","started_at");