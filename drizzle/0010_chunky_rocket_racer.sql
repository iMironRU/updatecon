ALTER TABLE "release_projects" ADD COLUMN "catalog_state" text DEFAULT 'discovered' NOT NULL;--> statement-breakpoint
UPDATE "release_projects" rp
SET "catalog_state" = 'ready'
WHERE EXISTS (
  SELECT 1 FROM "release_project_versions" rpv WHERE rpv."project_id" = rp."id"
);--> statement-breakpoint
CREATE INDEX "release_projects_catalog_state_idx" ON "release_projects" USING btree ("catalog_state");
