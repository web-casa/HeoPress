CREATE TABLE "lumibase_auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"amr" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "lumibase_refresh_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "lumibase_refresh_tokens" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_auth_sessions" ADD CONSTRAINT "lumibase_auth_sessions_user_id_lumibase_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "lumibase_auth_sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "lumibase_refresh_tokens" ADD CONSTRAINT "lumibase_refresh_tokens_session_id_lumibase_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."lumibase_auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "lumibase_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
-- Refresh tokens from before login sessions carry no issuance generation or
-- authentication provenance; none is inferred for them. They are revoked:
-- everyone signs in once after this upgrade (spec sites/site-switching).
UPDATE "lumibase_refresh_tokens" SET "revoked_at" = now() WHERE "session_id" IS NULL AND "revoked_at" IS NULL;
