---
version: 2
lastUpdated: 2026-08-02T19:05:49.466Z
sourceLang: en
contentHash: 8213b15617869cfe
codeVerified: 2026-08-02T19:05:54.545Z
codeVerifiedHash: 8213b15617869cfe
codeVerifiedClaims: 26
---

# HeoPress Production Deployment Checklist

> Complete checklist for deploying HeoPress to production. HeoPress runs on Node.js in **Docker** (self-hosted); the Cloudflare Workers target was removed in P02.

---

## Table of Contents

1. [Pre-Deployment Preparation](#1-pre-deployment-preparation)
2. [Infrastructure Setup](#2-infrastructure-setup)
3. [Secrets & Environment Variables](#3-secrets--environment-variables)
4. [Database Setup](#4-database-setup)
5. [Storage & Services](#5-storage--services)
7. [Docker Deployment](#7-docker-deployment)
8. [Post-Deployment Verification](#8-post-deployment-verification)
9. [Security Hardening](#9-security-hardening)
10. [Monitoring & Observability](#10-monitoring--observability)
11. [Backup & Recovery](#11-backup--recovery)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Pre-Deployment Preparation

### Code Readiness

- [ ] All tests pass: `pnpm test`
- [ ] Type check passes: `pnpm typecheck`
- [ ] Build succeeds: `pnpm build`
- [ ] No `console.log` statements in production code
- [ ] All TODO/FIXME items addressed or documented
- [ ] CHANGELOG updated with release notes

### Version & Release

- [ ] Version bumped in `package.json` files
- [ ] Git tag created: `git tag v0.x.x`
- [ ] Release branch created (if using GitFlow)

---

## 2. Infrastructure Setup

### Docker (Self-Hosted Deployment)

- [ ] Docker Engine 24+ installed
- [ ] Docker Compose v2 installed
- [ ] Sufficient resources: 4GB+ RAM, 20GB+ disk
- [ ] Domain pointing to server IP
- [ ] Firewall rules configured (allow 80, 443)

---

## 3. Secrets & Environment Variables

### Generate Secrets

```bash
# JWT Secret (required)
openssl rand -base64 32

# Encryption Key (required)
openssl rand -base64 32

# MeiliSearch master key (only with the optional MeiliSearch backend)
openssl rand -base64 32

# Metrics Token
openssl rand -base64 24
```

### Docker Environment

- [ ] Copy template: `cp docker/.env.example docker/.env`
- [ ] Fill all `REPLACE_*` placeholders
- [ ] Verify no dev values remain:
  ```bash
  grep -E "dev_secret|heopress_dev|minioadmin|REPLACE" docker/.env
  # Should return empty!
  ```

### Critical Security Checks

- [ ] `HEOPRESS_DEV_AUTH=false` (CRITICAL!)
- [ ] `HEOPRESS_ENV=production`
- [ ] `JWT_SECRET` is random (not `dev_secret_key`)
- [ ] `ENCRYPTION_KEY` is set
- [ ] `DATABASE_SSL_MODE=require` (not `disable`)
- [ ] `CORS_ALLOWED_ORIGINS` does not contain `*` or `localhost`

---

## 4. Database Setup

### PostgreSQL Requirements

- [ ] PostgreSQL 15+ running
- [ ] SSL/TLS enabled
- [ ] Dedicated user with limited privileges:
  ```sql
  CREATE USER heopress WITH PASSWORD 'strong_password';
  CREATE DATABASE heopress OWNER heopress;
  GRANT ALL PRIVILEGES ON DATABASE heopress TO heopress;
  ```
- [ ] Connection pooling (PgBouncer or Hyperdrive)

### Run Migrations

```bash
# From the repo root (db:migrate is a root script)
pnpm db:migrate

# Dry-run the pending migrations first
pnpm db:migrate:preflight

# Or, filtering to the package — note the script there is `migrate`, not `db:migrate`
pnpm -F @heopress/database migrate
```

- [ ] Migrations completed without errors
- [ ] Schema version matches codebase

### Database Security

- [ ] Row Level Security (RLS) enabled
- [ ] No public schema access
- [ ] Audit logging enabled
- [ ] Backup schedule configured

---

## 5. Storage & Services

### S3-Compatible Storage

- [ ] Bucket created with appropriate permissions
- [ ] CORS configured for your domains:
  ```json
  {
    "AllowedOrigins": ["https://studio.example.com"],
    "AllowedMethods": ["GET", "PUT", "POST"],
    "AllowedHeaders": ["*"]
  }
  ```
- [ ] Lifecycle rules for temp uploads (optional)

### Search

- [ ] Default: PostgreSQL search — nothing to run; `/health/ready` reports
      `chineseSearch: zhparser` on the HeoPress database image
- [ ] Optional MeiliSearch: instance running, master key set (not default),
      origin listed in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` if on a private network

### Database capabilities

- [ ] PostgreSQL 18 from the HeoPress database image (pgvector, zhparser), or
      a managed PostgreSQL 18 with `pg_trgm` (and `vector` if `HEOPRESS_VECTOR_SEARCH=true`)
- [ ] Backups cover the whole database: cache, queue, schedules and search live there too

---

## 7. Docker Deployment

### Pre-Deploy Checks

- [ ] `docker/.env` configured (from `docker/.env.example`)
- [ ] Docker images pulled: `docker compose pull`
- [ ] Volumes created for persistence

### Deploy

```bash
cd docker

# Database, API (runs migrations on start) and worker
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Wait for services to be healthy
docker compose ps

# (Optional) Start with TLS
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

- [ ] All containers running: `docker compose ps`
- [ ] No restart loops in logs: `docker compose logs --tail=100`
- [ ] Health check passes:
  ```bash
  curl http://localhost:1989/health/ready
  ```

### Scaling (Optional)

The compose file already splits the API (`cms`, `HEOPRESS_PROCESS_ROLE=web`)
from the worker (`cms-worker`, `HEOPRESS_PROCESS_ROLE=worker`). Both scale:

```bash
docker compose up -d --scale cms-worker=2
```

| Service | `HEOPRESS_PROCESS_ROLE` | Listens on |
|---------|-------------------------|------------|
| `cms` | `web` | `PORT` (default 1989) — Delivery + API |
| `cms-worker` | `worker` | `HEOPRESS_WORKER_HEALTH_PORT` (default 1988) — `/health` only |

Queue jobs are claimed in PostgreSQL, and each scheduled slot runs on exactly
one worker (`lumibase_schedule_runs`), so extra workers neither duplicate cron
ticks nor double-process jobs. Scaling `cms` needs a load balancer in front
(the host port can be bound only once).

---

## 8. Post-Deployment Verification

### Health & Connectivity

```bash
# Health endpoint
curl https://api.yourdomain.com/health
# Expected: { "status": "ok", "env": "production", ... }

# API version
curl https://api.yourdomain.com/api/v1/health
```

- [ ] Health check returns `ok`
- [ ] Database connection working
- [ ] Storage connection working
- [ ] Search connection working

### Functional Tests

- [ ] Admin login works
- [ ] Create a test site
- [ ] Create content item
- [ ] Upload media file
- [ ] Search returns results
- [ ] WebSocket realtime works (if enabled)

### Performance Baseline

- [ ] Response time < 200ms for simple queries
- [ ] No memory leaks (monitor over 1 hour)
- [ ] CPU usage stable under load

---

## 9. Security Hardening

### Authentication

- [ ] Dev auth disabled (`HEOPRESS_DEV_AUTH=false`)
- [ ] JWT expiration configured appropriately
- [ ] Rate limiting enabled
- [ ] Account lockout working

### Network

- [ ] HTTPS enforced (no HTTP)
- [ ] HSTS header enabled
- [ ] CORS restricted to known origins
- [ ] CSP headers configured (for Studio)

### API Security

- [ ] `/metrics` endpoint protected by `METRICS_TOKEN`
- [ ] GraphQL introspection disabled in production
- [ ] File upload MIME type validation enabled

### Data Protection

- [ ] Encryption at rest (database)
- [ ] Encryption in transit (TLS everywhere)
- [ ] Field encryption for sensitive data (`ENCRYPTION_KEY`)
- [ ] PII audit logging enabled

---

## 10. Monitoring & Observability

### Error Tracking

- [ ] Alert rules configured

### Metrics

- [ ] Prometheus scraping `/metrics`
- [ ] Grafana dashboards set up
- [ ] Key metrics monitored:
  - [ ] Request rate
  - [ ] Error rate (5xx)
  - [ ] Response latency (p50, p95, p99)
  - [ ] Database query duration
  - [ ] Active connections

### Logging

- [ ] Structured JSON logs enabled
- [ ] Log aggregation set up (Loki, CloudWatch, etc.)
- [ ] Log retention policy configured
- [ ] Sensitive data not logged

### Alerting

- [ ] Error rate spike alert
- [ ] Latency degradation alert
- [ ] Database connection pool exhaustion alert
- [ ] Disk space alert (Docker)
- [ ] Certificate expiry alert

---

## 11. Backup & Recovery

### Database Backups

- [ ] Automated daily backups
- [ ] Backups stored off-site (S3, etc.)
- [ ] Backup encryption enabled
- [ ] Retention policy: 30 days minimum
- [ ] Backup restoration tested

### Media Backups

- [ ] S3 versioning enabled (or cross-region replication)
- [ ] Lifecycle rules for old versions

### Configuration Backups

- [ ] Docker `.env` backed up securely (encrypted)
- [ ] Secrets documented in password manager

### Disaster Recovery

- [ ] Recovery procedure documented
- [ ] Recovery time objective (RTO) defined
- [ ] Recovery point objective (RPO) defined
- [ ] DR test performed

---

## 12. Troubleshooting

### Common Issues

#### Health check fails

```bash
# Check service logs
docker compose logs cms --tail=100

# Check the database connection by dry-running migrations
docker compose exec cms pnpm -F @heopress/database migrate:preflight

# Readiness names the failing dependency (database, migrations, extensions, …)
curl -s http://localhost:1989/health/ready
```

#### 500 errors on requests

```bash
# Check for missing secrets
grep "JWT_SECRET\|ENCRYPTION_KEY" docker/.env

```

#### Database connection errors

- Verify `DATABASE_URL` format
- Check SSL mode matches server config
- Verify network connectivity
- Check connection pool limits

#### CORS errors

- Verify `CORS_ALLOWED_ORIGINS` includes your frontend domain
- Check for trailing slashes (should not have them)
- Verify protocol (https, not http)

### Rollback Procedure

```bash
# Docker
docker compose down
docker compose pull  # pull previous tag
docker compose up -d
```

---

## Quick Reference: Required Secrets

### Docker

| Variable | Required | Generate |
|----------|----------|----------|
| `JWT_SECRET` | Yes | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | Yes | `openssl rand -base64 32` |
| `DATABASE_URL` | Yes | Connection string with SSL |
| `S3_ACCESS_KEY` | With `HEOPRESS_STORAGE=s3` | From provider |
| `S3_SECRET_KEY` | With `HEOPRESS_STORAGE=s3` | From provider |
| `MEILISEARCH_API_KEY` | With `MEILISEARCH_HOST` | `openssl rand -base64 32` |

---

## Sign-Off

| Check | Verified By | Date |
|-------|-------------|------|
| Pre-deployment complete | | |
| Infrastructure ready | | |
| Secrets configured | | |
| Database migrated | | |
| Services healthy | | |
| Security hardened | | |
| Monitoring active | | |
| Backups verified | | |

**Deployed Version:** `v____`
**Deployment Date:** `____-__-__`
**Deployed By:** `____________`
