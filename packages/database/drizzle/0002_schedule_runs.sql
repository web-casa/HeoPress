CREATE TABLE "lumibase_schedule_runs" (
	"schedule_key" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "lumibase_schedule_runs_schedule_key_scheduled_at_pk" PRIMARY KEY("schedule_key","scheduled_at")
);
--> statement-breakpoint
CREATE INDEX "schedule_runs_started_idx" ON "lumibase_schedule_runs" USING btree ("started_at");