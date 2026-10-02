CREATE TABLE IF NOT EXISTS "platform_builds" (
	"version" text PRIMARY KEY NOT NULL,
	"nick" text NOT NULL,
	"line" text NOT NULL,
	"release_date" date,
	"os" text[],
	"notes_url" text,
	"bugs_url" text,
	"details_status" text,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_builds_line_idx" ON "platform_builds" USING btree ("line");