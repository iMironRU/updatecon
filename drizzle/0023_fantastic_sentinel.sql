ALTER TABLE "patches" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "source" text DEFAULT 'portal' NOT NULL;