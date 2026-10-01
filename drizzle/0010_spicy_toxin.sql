CREATE TABLE IF NOT EXISTS "transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_config_id" integer,
	"from_name" text NOT NULL,
	"from_vendor" text DEFAULT '' NOT NULL,
	"to_config_id" integer NOT NULL,
	"kind" text NOT NULL,
	"packages" integer DEFAULT 0 NOT NULL,
	"from_min" text,
	"from_max" text,
	"to_min" text,
	"to_max" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transitions" ADD CONSTRAINT "transitions_from_config_id_configurations_id_fk" FOREIGN KEY ("from_config_id") REFERENCES "public"."configurations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transitions" ADD CONSTRAINT "transitions_to_config_id_configurations_id_fk" FOREIGN KEY ("to_config_id") REFERENCES "public"."configurations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transitions_from_idx" ON "transitions" USING btree ("from_config_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transitions_to_idx" ON "transitions" USING btree ("to_config_id");