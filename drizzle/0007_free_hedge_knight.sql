CREATE TABLE IF NOT EXISTS "package_manifests" (
	"dir" text PRIMARY KEY NOT NULL,
	"app_version" text,
	"status" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
