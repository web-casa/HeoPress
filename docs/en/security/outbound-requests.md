# Outbound requests

Every HTTP request HeoPress makes to another system goes through one boundary, `outboundFetch` in `@heopress/runtime/node` (HeoPress P03, spec `platform/outbound-security`, ADR-0014). That covers webhooks and Change Feed deliveries, Flow `http` operations, revalidation targets, extension downloads and extension `http:fetch`, deployment providers, model / decision / embedding providers and identity-provider discovery. Storage and search endpoints use the same address rules.

## What the boundary enforces

- **Schemes:** `http` and `https` only; no `user:password@` in URLs.
- **Addresses, checked when connecting.** Every address a host name resolves to is checked inside the connection's DNS lookup, so the address that was checked is the address that is used. A name that resolves to a public address for a check and to an internal one for the connection (DNS rebinding) has nothing to exploit.
- **Refused ranges:** loopback, private (RFC 1918), CGNAT, link-local, unique-local IPv6, documentation and benchmarking ranges, multicast and reserved space — including the same addresses written as IPv4-mapped IPv6 (`::ffff:10.0.0.1`), NAT64 (`64:ff9b::…`) or 6to4 (`2002:…`).
- **Cloud metadata endpoints** (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`, …) are refused in every case.
- **Redirects** are followed by hand, at most 5 hops, and every hop is checked again. When a hop changes origin, credential headers are dropped: `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`, `X-Auth-Token`, `API-Key`, plus any the caller names. Webhook deliveries follow no redirects at all.
- **Limits:** response body 10 MiB, 30 s per request including redirects (model calls allow 5 min) unless the caller sets other limits.

A refused request throws `OutboundBlockedError` ("outbound request blocked: …") before anything is sent.

## Trusted internal services

Self-hosted services on a private network — MinIO, a crawler, a local model server, MeiliSearch — are reachable only when their exact origin is listed:

```bash
HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS=http://minio:9000,http://crawl4ai:11235,http://ollama:11434
```

- An entry is an origin: scheme, host and port (`http://crawl4ai:11235`). Paths, credentials and wildcards are rejected with a startup warning.
- The match is exact: `http://crawl4ai:11236` or `https://crawl4ai:11235` is not trusted.
- Trust applies only to **service connections** — configured model, storage, crawler, search and mail endpoints. A URL that comes from content or a user (a source URL, an image URL, a webhook or Flow target) is checked under the normal rules even if it names a listed origin, so `http://crawl4ai:11235/` entered as a feed URL is refused.
- A service connection never follows a redirect to another origin (its credentials travel in provider-specific headers); a URL from content or a user that redirects is checked again at every hop under the normal rules.
- A metadata address in the list is ignored with a startup warning, and requests to it are still refused.

The minimal compose file needs no trusted endpoints. With the optional `s3` or `meilisearch` profiles, add `http://seaweedfs:8333` / `http://meilisearch:7700` to `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`; when you add another service to compose, add its origin there too. The MeiliSearch client sends every request through `outboundFetch`, so a redirect from MeiliSearch to another origin is refused like any other service redirect.

## Credentials stay with their site

Endpoint, allow-list and credential settings can be changed only by site administrators (`requireSiteAdmin`). A service bound to one site treats another site's configuration as nonexistent, and credentials never appear in responses, errors or audit entries (`config-boundary.db.integration.test.ts`).
