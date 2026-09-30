CREATE TABLE IF NOT EXISTS "template_tags" (
	"template_key" text NOT NULL,
	"tag" text NOT NULL,
	"kind" text DEFAULT 'own' NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_tags_template_key_tag_pk" PRIMARY KEY("template_key","tag")
);
