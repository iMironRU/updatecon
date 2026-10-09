CREATE TABLE IF NOT EXISTS "release_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"config_id" integer,
	"version" text,
	"date" date NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "last_event_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_events_type_key_uq" ON "release_events" USING btree ("type","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_events_date_idx" ON "release_events" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_events_config_idx" ON "release_events" USING btree ("config_id","id");--> statement-breakpoint
-- the lowest platform build named in a requirement ("8.3.27.1688, 8.5.1.1150" → {8,3,27,1688}); NULL when none
CREATE OR REPLACE FUNCTION plat_min(t text) RETURNS bigint[] LANGUAGE sql IMMUTABLE AS $$
  SELECT min(string_to_array(m[1], '.')::bigint[]) FROM regexp_matches(coalesce(t, ''), '(\d+\.\d+\.\d+\.\d+)', 'g') AS m
$$;
