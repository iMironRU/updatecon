DROP INDEX "release_change_events_detected_idx";--> statement-breakpoint
ALTER TABLE "release_change_events" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
UPDATE "release_change_events"
SET "occurred_at" = CASE
  WHEN "event_type" = 'new_version' AND "details"->>'releaseDate' ~ '^\d{4}-\d{2}-\d{2}$'
    THEN (("details"->>'releaseDate')::date)::timestamp AT TIME ZONE 'UTC'
  WHEN "event_type" = 'resource_added' AND "details"->>'publishedAt' ~ '^\d{4}-\d{2}-\d{2}$'
    THEN (("details"->>'publishedAt')::date)::timestamp AT TIME ZONE 'UTC'
  WHEN "event_type" = 'patch_added' AND "details"->>'patchDate' ~ '^\d{4}-\d{2}-\d{2}$'
    THEN (("details"->>'patchDate')::date)::timestamp AT TIME ZONE 'UTC'
  ELSE "detected_at"
END;--> statement-breakpoint
ALTER TABLE "release_change_events" ALTER COLUMN "occurred_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "release_change_events" ALTER COLUMN "occurred_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "release_change_events_occurred_idx" ON "release_change_events" USING btree ("occurred_at","id");
