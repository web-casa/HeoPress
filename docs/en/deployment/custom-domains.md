# Custom domains and on-demand TLS

Each site in a network can serve on its own domains. A domain serves nothing
until the site proves it controls it. A certificate is issued only for a
domain that is verified and active. This page covers both halves: domains in
the CMS, and Caddy issuing certificates on first visit.

## 1. Domains in the CMS

`/api/v1/domains` (site administrators only):

| Call | What it does |
|---|---|
| `POST /` `{kind: 'custom', hostname, verificationMethod?, entryLocale?}` | Claim a domain: status `pending`, with a token of its own, valid 7 days |
| `POST /:id/verify` | Check the token now. When it is published, the domain becomes `active` |
| `POST /:id/token` | Issue a new token (the old one stops working) |
| `POST /:id/primary` | Make an active domain the site's primary domain |
| `PATCH /:id` `{status?, entryLocale?}` | Switch a domain off (`disabled`) or back on, or register it as a language entry |
| `DELETE /:id` | Remove it |

**Verification.** Every claim (one site, one hostname) has its own random
token. Publish it in one of two ways:

- `dns_txt` (the default) — a TXT record `_heopress-challenge.<hostname>` containing the token.
- `http_file` — `http://<hostname>/.well-known/heopress-verification.txt` serving the token.
  It is fetched through the outbound boundary, so private networks are refused, size and time are bounded, and redirects are re-checked.
  Use it while the domain is still served by the old host. Once DNS points at HeoPress, use `dns_txt`.

A copied record from another claim does not verify, because the token belongs
to the claim. An expired token verifies nothing. Several sites may claim one
hostname while it is pending. The first to verify owns it. While it is active
on one site, no other site can activate it.

**Serving.** A visitor's `Host` is resolved to a site by its active domains.
Other active domains of the site answer `301` to the primary domain, keeping
the path and query. A domain registered as a **language entry** keeps its host
and serves that language. `X-Forwarded-Host` is honoured only from addresses in
`HEOPRESS_TRUSTED_PROXIES`.

## 2. Certificates on first visit (Caddy)

`docker/Caddyfile.domains` serves the admin/API host (`PUBLIC_DOMAIN`, with a
certificate at startup, forwarded to the CMS) and every other name with
**on-demand TLS**, forwarded to the public-site rendering service
(`site-classic`, HeoPress P06). On those names `/admin*`, `/api*` and
`/internal*` are answered with `404` at the edge and never forwarded
(`docker/scripts/smoke-caddy-routing.sh` checks the routing). Before
Caddy obtains a certificate for a name it has not seen, it asks the CMS:

```
GET http://cms:1989/internal/tls/ask?domain=<hostname>
```

| Answer | When |
|---|---|
| `200` | the hostname is an active domain of some site, or the host of `HEOPRESS_PREVIEW_ORIGIN` |
| `404` | unknown, pending, disabled — no certificate is requested |
| `400` | not a hostname |
| `403` | not from an internal address, or forwarded by a proxy |
| `429` | over `HEOPRESS_TLS_ASK_RATE` per minute (default 120) for that caller |

The gate is reachable only from addresses in `HEOPRESS_TLS_ASK_ALLOW`. The
default is loopback and the private ranges, which covers the Compose network.
The address checked is the TCP peer, never a header. Caddy's own question
carries no forwarding headers. A visitor's request that Caddy forwards to the
CMS (admin host only) comes from the same private address, but it carries
`X-Forwarded-For`, so the gate refuses it. Both Caddyfiles also answer `/internal/*` with `404` at
the edge.

Run it with the TLS overlay plus the domains overlay:

```bash
cd docker
# The rendering service's role: the CMS creates it with this password; the
# rendering service connects with the URL (both also as *_FILE secrets).
export HEOPRESS_RENDER_PASSWORD="$(openssl rand -hex 24)"
export HEOPRESS_RENDER_DATABASE_URL="postgresql://heopress_render:${HEOPRESS_RENDER_PASSWORD}@postgres:5432/heopress"
PUBLIC_DOMAIN=admin.example.com ACME_EMAIL=ops@example.com \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    -f docker-compose.tls.yml -f docker-compose.domains.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    -f docker-compose.tls.yml -f docker-compose.domains.yml ps site-classic   # expect: healthy
```

Without the password the CMS refuses to start under the domains overlay (before
migrating), so nothing comes up half-configured; without the connection string
`site-classic` refuses to start. Sites that existed before
the rendering service are built by the worker within seconds of the upgrade
(migration 0040 queues them); until then they answer with a maintenance page.

Then, for each site domain:

1. Point the domain's `A`/`AAAA` (or `CNAME`) records at this server.
2. Claim it in Studio → Settings → Domains (or `POST /api/v1/domains`), and publish the TXT record shown.
3. Verify it. The first HTTPS visit obtains the certificate, which takes a few seconds once. Later visits use the stored certificate, and Caddy renews it.

A domain that is disabled or removed gets no new certificate. A certificate
already issued stays in Caddy's storage until it expires, but the CMS no
longer serves a site on that host.

Rate limits of the ACME CA (for Let's Encrypt, certificates per registered
domain per week) apply per name. For a large network, add domains in batches,
and test with the CA's staging endpoint first (`acme_ca` in the global block).

## 3. Checking it

Without a public domain, Caddy's internal CA exercises the same gate. Add
`local_certs` to the global block of a copy of `Caddyfile.domains`:

```bash
# a domain the CMS does not know: no certificate, so the handshake fails
curl -sk --resolve unknown.example.net:443:127.0.0.1 https://unknown.example.net/ -o /dev/null -w '%{http_code}\n'   # 000
# after claiming and verifying example.org for a site
curl -sk --resolve example.org:443:127.0.0.1 https://example.org/ -o /dev/null -w '%{http_code}\n'               # an HTTP status
# the gate is not reachable through Caddy
curl -sk --resolve example.org:443:127.0.0.1 'https://example.org/internal/tls/ask?domain=example.org' -o /dev/null -w '%{http_code}\n'   # 404
```

## 4. Settings

| Variable | Default | Meaning |
|---|---|---|
| `HEOPRESS_TLS_ASK_ALLOW` | loopback, `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` | CIDRs that may ask the certificate gate |
| `HEOPRESS_TLS_ASK_RATE` | `120` | Questions per minute per caller; `0` turns the limit off |
| `HEOPRESS_TRUSTED_PROXIES` | — | Proxies whose `X-Forwarded-For` / `X-Forwarded-Host` are honoured |
