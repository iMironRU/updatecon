ALTER TABLE "import_runs" ALTER COLUMN "file_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "release_project_versions" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "release_project_versions" ALTER COLUMN "file_size_bytes_override" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "release_version_resources" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "release_version_resources" ALTER COLUMN "file_size_bytes_override" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "version_meta" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;