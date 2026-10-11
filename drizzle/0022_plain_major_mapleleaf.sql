CREATE TABLE IF NOT EXISTS "chain_checks" (
	"config_id" integer NOT NULL,
	"version" text NOT NULL,
	"program_name" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"svc_next" text,
	"svc_files" integer,
	"svc_size" bigint,
	"svc_platform" text,
	"our_next" text,
	"our_steps" integer,
	"status" text NOT NULL,
	"note" text,
	CONSTRAINT "chain_checks_config_id_version_pk" PRIMARY KEY("config_id","version")
);
