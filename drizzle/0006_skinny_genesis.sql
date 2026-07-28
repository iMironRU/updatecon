CREATE TABLE "release_version_resources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_version_id" integer NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"category" text DEFAULT 'additional' NOT NULL,
	"title" text NOT NULL,
	"href" text NOT NULL,
	"properties_id" text,
	"file_extension" text,
	"is_file" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_version_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_version_id" integer NOT NULL,
	"from_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "recommended_platform" text;--> statement-breakpoint
ALTER TABLE "release_project_versions" ADD COLUMN "resources_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD CONSTRAINT "release_version_resources_project_version_id_release_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."release_project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_version_transitions" ADD CONSTRAINT "release_version_transitions_project_version_id_release_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."release_project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_version_resources_uq" ON "release_version_resources" USING btree ("project_version_id","href");--> statement-breakpoint
CREATE INDEX "release_version_resources_version_idx" ON "release_version_resources" USING btree ("project_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_version_transitions_uq" ON "release_version_transitions" USING btree ("project_version_id","from_version");--> statement-breakpoint
CREATE INDEX "release_version_transitions_from_idx" ON "release_version_transitions" USING btree ("from_version");