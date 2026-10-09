CREATE TABLE IF NOT EXISTS "version_news" (
	"config_id" integer NOT NULL,
	"version" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_news_config_id_version_pk" PRIMARY KEY("config_id","version")
);
