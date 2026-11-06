CREATE TABLE "history_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"source" text NOT NULL,
	"counts" text NOT NULL,
	"note" text,
	"first_day" date NOT NULL,
	"last_day" date NOT NULL,
	"days" integer NOT NULL,
	"page_views" integer NOT NULL,
	"events" integer NOT NULL,
	"checksum" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "history_import_siteId_source_unique" UNIQUE("site_id","source")
);
--> statement-breakpoint
ALTER TABLE "history_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_dimension" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_site" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "history_import" ADD CONSTRAINT "history_import_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "history_import" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "history_import" TO tenant_app;
