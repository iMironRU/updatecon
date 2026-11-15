CREATE TABLE IF NOT EXISTS "ocr_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"engine" text NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"tokens" jsonb,
	"image_w" integer,
	"image_h" integer,
	"image_bytes" integer,
	"version_value" text,
	"version_distance" integer,
	"platform_value" text,
	"platform_distance" integer,
	"applied_version" text,
	"corrected" boolean DEFAULT false NOT NULL,
	"built" boolean DEFAULT false NOT NULL,
	"sample_path" text,
	"ua" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ocr_events_at_idx" ON "ocr_events" USING btree ("at");