CREATE TABLE "lumibase_site_id_reuse_exemption" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"except_prefix" text NOT NULL
);
