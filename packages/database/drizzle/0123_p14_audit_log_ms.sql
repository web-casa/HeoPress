-- HeoPress P14 task 3.2 (spec ops/audit-log "审计日志翻页完整", design D3): audit timestamps in milliseconds, the precision
-- of the page cursor (`toISOString()`), so a cursor never falls between rows of one millisecond. Existing rows are rounded.
ALTER TABLE "lumibase_audit_log" ALTER COLUMN "timestamp" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "lumibase_audit_log" ALTER COLUMN "timestamp" SET DEFAULT now();