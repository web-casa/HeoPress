---
version: 2
lastUpdated: 2026-11-12T06:15:38.546Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: db2683573845b226
mtEngine: manual
syncStatus: human-translated
---

<!-- check-parity: allow bulk -->
<!-- Chinese and English prose differ in character count by construction; both sides carry the same sections, commands and table. -->

# Pre-launch acceptance checklist

Run this before you use HeoPress for real sites, and before you promise anyone availability. It contains only the
checks **this repository cannot do for you**: everything automation can prove — installation, minimal deployment,
upgrade path, backup suite, permission isolation, rendering correctness — runs in CI on every commit.

Record every item (date, environment, command, result) in your operations log. No record means not done.

## 1. Capacity: rerun the benchmark on the real VPS

The numbers under `docs/benchmarks/` come from a 2 vCPU / 4 GB machine **simulated** with Docker limits on a developer
host, and that documentation says plainly not to plan capacity from them. Rerun on the machine you will use:

```bash
export COMPOSE_PROJECT_NAME=hpbench POSTGRES_PORT=56433 CMS_PORT=11989 SITE_PORT=12027 BENCH_OUT=/tmp/bench-p06
# CMS port, render port, articles per site
docker/scripts/bench-p06-classic.sh 11989 12027 1000
```

Pass criteria (the design's targets): miss p95 **< 300 ms**, cache-hit p95 **< 30 ms**, zero failed requests in every
phase, and the expected `x-cache` tier. Record the machine type, cores, memory, disk type, the measured p50/p95/p99 and
the render service's peak RSS.

How to read it: if hit p95 exceeds 30 ms, first check whether the database hit its limit (the benchmark caps postgres at
0.6 CPU), then decide between more cores and more cache — do not explain the gap away with "the dev machine is faster".

## 2. Upgrade: rehearse on a copy

`heopress upgrade` runs a compatibility check, a backup, **a migration rehearsal on a database copy**, a maintenance
window that freezes writes, a final backup, the migration, the application switch, a smoke test and reopening writes.
A passing rehearsal does not mean your database is fine: plugins, custom collections and real data volumes can expose
what a rehearsal did not cover.

```bash
# confirm the flags of your version first
heopress upgrade --help
```

Run it end to end on a **copy of the production database** (a copy restored by `heopress backup restore` is ideal) and
record: duration, maintenance-window length, whether the rehearsal passed, whether the smoke test passed. If the
rehearsal fails, the upgrade never enters maintenance — keep that output, it is your only safe chance to fail.

**Once a newer version reopens writes you cannot roll back**: restoring the old backup loses everything written after
it. Confirm you accept that before starting.

## 3. Backup and restore: drill it, do not just enable it

```bash
# take one now
heopress backup run
# check the manifest and readability
heopress backup verify
# restore into a scratch instance and check
heopress backup drill
```

Pass criteria: `verify` reports no errors, `drill` restores and completes its checks, and the restored site and article
counts match what you expect. **Keep the key separately** — lose the encryption key and the backup is worthless. The
full procedure is in the backup and restore guide, which is Chinese only:
[备份与恢复](../../zh-CN/operations/backup-restore.md).

If you do only one thing, do this one: a backup you never restored is not a backup.

## 4. Security posture: read the exception list

Every entry in `security/exceptions.json` is a risk **we know about and accept**, not a fixed problem. Read it before
going live and confirm you accept it:

- every entry carries a `reason` and a `reviewBy`; an expired review turns the security scan red, which is the reminder
  working as designed;
- today it is mostly the krb5 libraries of the postgres base image (unfixed in Debian, KDC-side flaws, and the image
  runs no KDC);
- recheck the latest dependency-audit and image-scan results — do not rely on "it was green last time".

Also confirm: site domains are verified, TLS is issued by Caddy, and `HEOPRESS_REQUIRE_APP_ROLE` is true so the
application connects with the restricted role.

## 5. Go / No-Go

| Item | Pass criterion | Record |
|---|---|---|
| Capacity | miss p95 < 300 ms, hit p95 < 30 ms, zero failures | machine type and measured numbers |
| Upgrade | copy rehearsal and smoke test pass | duration and maintenance window |
| Backup | `verify` and `drill` pass | counts checked after restore |
| Security | exceptions read, audit and image scan have nothing open | review date |
| Rollback | you know and accept "no rollback after writes reopen" | who decided |

All five recorded is the only state in which you may promise availability. Missing any one, the honest claim is
"deployable for a trial".
