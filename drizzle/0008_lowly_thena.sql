ALTER TABLE "release_version_resources" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "file_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "published_at" date;--> statement-breakpoint
ALTER TABLE "release_version_resources" ADD COLUMN "sha512" text;--> statement-breakpoint
DELETE FROM "release_version_resources"
WHERE "kind" = 'readme' AND "href" NOT LIKE '/version_file?%';--> statement-breakpoint
UPDATE "release_project_versions" rpv
SET "resources_synced_at" = NULL
WHERE EXISTS (
	SELECT 1 FROM "release_version_resources" rvr
	WHERE rvr."project_version_id" = rpv."id"
);
