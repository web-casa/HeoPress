CREATE TABLE "lumibase_search_documents" (
	"index_name" text NOT NULL,
	"doc_id" text NOT NULL,
	"document" jsonb NOT NULL,
	"language" text NOT NULL,
	"search_text" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_search_documents_index_name_doc_id_pk" PRIMARY KEY("index_name","doc_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_search_indexes" (
	"index_name" text PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_documents_tsv_idx" ON "lumibase_search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_documents_trgm_idx" ON "lumibase_search_documents" USING gin ("search_text" gin_trgm_ops);