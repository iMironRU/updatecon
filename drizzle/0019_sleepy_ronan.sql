DROP INDEX IF EXISTS "patches_uuid_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patches_config_version_uuid_uq" ON "patches" USING btree ("config_id","version","uuid");