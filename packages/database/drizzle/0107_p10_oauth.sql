CREATE TABLE "lumibase_agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"client_id" text,
	"name" text NOT NULL,
	"site_ids" text[] NOT NULL,
	"tool_groups" text[] NOT NULL,
	"resource" text NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"token_hash" text,
	"token_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "agent_grants_kind" CHECK ("lumibase_agent_grants"."kind" IN ('oauth', 'pat')),
	CONSTRAINT "agent_grants_oauth_client" CHECK ("lumibase_agent_grants"."kind" <> 'oauth' OR "lumibase_agent_grants"."client_id" IS NOT NULL),
	CONSTRAINT "agent_grants_pat_hash" CHECK ("lumibase_agent_grants"."kind" <> 'pat' OR "lumibase_agent_grants"."token_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "lumibase_agent_idempotency" (
	"subject" text NOT NULL,
	"tool" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_agent_idempotency_subject_tool_key_pk" PRIMARY KEY("subject","tool","key")
);
--> statement-breakpoint
CREATE TABLE "lumibase_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"client_secret_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registered_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_source" CHECK ("lumibase_oauth_clients"."source" IN ('dcr', 'cimd')),
	CONSTRAINT "oauth_clients_auth_method" CHECK ("lumibase_oauth_clients"."token_endpoint_auth_method" IN ('none', 'client_secret_basic', 'client_secret_post'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"parent_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_kind" CHECK ("lumibase_oauth_tokens"."kind" IN ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_agent_grants" ADD CONSTRAINT "lumibase_agent_grants_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_agent_grants" ADD CONSTRAINT "lumibase_agent_grants_client_id_lumibase_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."lumibase_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_oauth_codes" ADD CONSTRAINT "lumibase_oauth_codes_grant_id_lumibase_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."lumibase_agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_oauth_tokens" ADD CONSTRAINT "lumibase_oauth_tokens_grant_id_lumibase_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."lumibase_agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_grants_user_idx" ON "lumibase_agent_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_token_hash_unique" ON "lumibase_agent_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_token_hash_unique" ON "lumibase_oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "lumibase_oauth_tokens" USING btree ("grant_id");