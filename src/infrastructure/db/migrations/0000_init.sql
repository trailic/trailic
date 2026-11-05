-- Tenant isolation: a workspace's data is read and written as the restricted role tenant_app, with
-- the workspace set per transaction (app.workspace_id). It comes first: tables' defaults and policies name it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenant_app') THEN
    CREATE ROLE tenant_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT tenant_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tenant_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_workspace_id() TO tenant_app;--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('page', 'event', 'identify', 'vital');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "daily_dimension" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"count" integer NOT NULL,
	"visitors" integer NOT NULL,
	CONSTRAINT "daily_dimension_site_id_day_dimension_value_pk" PRIMARY KEY("site_id","day","dimension","value")
);
--> statement-breakpoint
ALTER TABLE "daily_dimension" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "daily_site" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"visitors" integer NOT NULL,
	"page_views" integer NOT NULL,
	"events" integer NOT NULL,
	"bounces" integer NOT NULL,
	CONSTRAINT "daily_site_site_id_day_pk" PRIMARY KEY("site_id","day")
);
--> statement-breakpoint
ALTER TABLE "daily_site" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "daily_vital" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"p75" real NOT NULL,
	"samples" integer NOT NULL,
	CONSTRAINT "daily_vital_site_id_day_metric_pk" PRIMARY KEY("site_id","day","metric")
);
--> statement-breakpoint
ALTER TABLE "daily_vital" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "erased_person" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"user_hash" text NOT NULL,
	"erased_at" timestamp with time zone NOT NULL,
	CONSTRAINT "erased_person_site_id_user_hash_pk" PRIMARY KEY("site_id","user_hash")
);
--> statement-breakpoint
ALTER TABLE "erased_person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "event" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" "event_kind" NOT NULL,
	"path" text,
	"name" text,
	"visitor" uuid,
	"user_id" text,
	"referrer" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"country" text,
	"device" text,
	"browser" text,
	"os" text,
	"props" jsonb,
	"value" real
) PARTITION BY RANGE ("at");
--> statement-breakpoint
ALTER TABLE "event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "flushed_batch" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"flushed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flushed_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "funnel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"window_hours" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_siteId_name_unique" UNIQUE("site_id","name")
);
--> statement-breakpoint
ALTER TABLE "funnel" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "person" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_site_id_user_id_pk" PRIMARY KEY("site_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"allowed_domains" text[] NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"last_written_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_publicKey_unique" UNIQUE("public_key"),
	CONSTRAINT "site_workspaceId_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "site" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[],
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invitation_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "daily_dimension" ADD CONSTRAINT "daily_dimension_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_site" ADD CONSTRAINT "daily_site_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_vital" ADD CONSTRAINT "daily_vital_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erased_person" ADD CONSTRAINT "erased_person_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel" ADD CONSTRAINT "funnel_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_dimension_workspace_id_dimension_day_index" ON "daily_dimension" USING btree ("workspace_id","dimension","day");--> statement-breakpoint
CREATE INDEX "daily_site_workspace_id_day_index" ON "daily_site" USING btree ("workspace_id","day");--> statement-breakpoint
CREATE INDEX "event_site_at" ON "event" USING btree ("site_id","at");--> statement-breakpoint
CREATE INDEX "event_site_visitor_at" ON "event" USING btree ("site_id","visitor","at") WHERE visitor is not null;--> statement-breakpoint
CREATE INDEX "event_site_user_at" ON "event" USING btree ("site_id","user_id","at") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "event_site_path_at" ON "event" USING btree ("site_id","path","at") WHERE kind = 'page';--> statement-breakpoint
CREATE INDEX "event_site_name_at" ON "event" USING btree ("site_id","name","at") WHERE kind = 'event';--> statement-breakpoint
CREATE INDEX "flushed_batch_flushed_at_index" ON "flushed_batch" USING btree ("flushed_at");--> statement-breakpoint
CREATE INDEX "person_site_id_last_seen_at_index" ON "person" USING btree ("site_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_index" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_index" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_index" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "api_key_workspace_id_index" ON "api_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_workspace_id_email_index" ON "invitation" USING btree ("workspace_id","email") WHERE accepted_at is null;--> statement-breakpoint
CREATE INDEX "invitation_email_index" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_dimension" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_site" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_vital" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "erased_person" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "event" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "flushed_batch" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "funnel" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "person" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "site" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_key" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitation" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
-- What the app role may do: read workspaces and memberships (written by the trusted server path
-- only), and read and write a workspace's own rows, behind row-level security. Identity and the
-- assistants' OAuth tables stay with the owner: only Better Auth's trusted path uses them.
GRANT SELECT ON "workspace", "member" TO tenant_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "invitation", "api_key", "site", "event", "daily_site", "daily_dimension", "daily_vital", "person", "erased_person", "funnel", "flushed_batch" TO tenant_app;--> statement-breakpoint
-- A month's raw events. Made as events need it, on the trusted path, because the app role can't
-- create tables. A partition read directly doesn't go through its parent's policies, so each carries
-- its own row-level security, the same policy and the same grants. The lock keeps two flushes from
-- racing to make the same one.
CREATE OR REPLACE FUNCTION ensure_event_partition(month date) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  first_day date := date_trunc('month', month)::date;
  partition_name text := format('event_%s', to_char(first_day, 'YYYY_MM'));
BEGIN
  IF to_regclass(partition_name) IS NOT NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(partition_name));
  IF to_regclass(partition_name) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF event FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    (first_day::timestamp AT TIME ZONE 'UTC'),
    ((first_day + interval '1 month')::timestamp AT TIME ZONE 'UTC')
  );
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I AS PERMISSIVE FOR ALL TO tenant_app USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', partition_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO tenant_app', partition_name);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ensure_event_partition(date) FROM PUBLIC;
