CREATE TABLE IF NOT EXISTS "solutions_info" (
	"url" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"product_kind" text,
	"enterprise_types" text[],
	"countries" text[],
	"developers" text[],
	"base_config" text,
	"industries" text[],
	"tasks" text[],
	"editions" text[],
	"support_phone" text,
	"support_email" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
