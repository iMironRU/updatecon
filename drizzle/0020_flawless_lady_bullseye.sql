CREATE TABLE "release_change_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"event_type" text NOT NULL,
	"project_id" integer NOT NULL,
	"project_version_id" integer,
	"config_id" integer,
	"version" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patches" DROP CONSTRAINT "patches_config_id_configurations_id_fk";
--> statement-breakpoint
ALTER TABLE "patches" ALTER COLUMN "config_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patches" ADD COLUMN "project_version_id" integer;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "patches_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_change_events" ADD CONSTRAINT "release_change_events_project_id_release_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."release_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_change_events" ADD CONSTRAINT "release_change_events_project_version_id_release_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."release_project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_change_events" ADD CONSTRAINT "release_change_events_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_change_events_dedupe_uq" ON "release_change_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "release_change_events_detected_idx" ON "release_change_events" USING btree ("detected_at","id");--> statement-breakpoint
CREATE INDEX "release_change_events_project_idx" ON "release_change_events" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "release_change_events_type_idx" ON "release_change_events" USING btree ("event_type","id");--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_project_version_id_release_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."release_project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_config_id_configurations_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."configurations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patches_project_version_idx" ON "patches" USING btree ("project_version_id");