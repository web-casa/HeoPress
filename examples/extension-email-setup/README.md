# Example extension: email-setup

Demonstrates how a HeoPress **extension** sends email by integrating with the
platform's built-in **EmailService** — instead of talking to an SMTP server or
email API itself.

## The split

| Concern | Owner |
| --- | --- |
| Trigger + any UI (when/why to send) | **The extension** (this example) |
| Transport (SMTP / MailChannels), deliverability, secrets | **HeoPress core** |
| Template + layout authoring/storage, rendering | **HeoPress core** (Studio → Settings → Email) |

The extension stays thin and portable: it only decides *who* to mail and *which
template* to use, then POSTs to HeoPress's core endpoint
`POST /api/v1/email/send`. HeoPress renders the stored template (with its
layout) and delivers it through whichever transport the deployment configured.

## How it works

This example is an **endpoint extension** (`manifest.json` → `"type":
"endpoint"`). It exposes:

```
POST /extensions/email-setup/notify
{ "to": ["teammate@example.com"], "variables": { "name": "Sam" }, "templateKey": "teammate_invite" }
```

On each call it forwards to the core service:

```
POST {EXTENSION_HEOPRESS_BASE_URL}/api/v1/email/send
Authorization: Bearer {EXTENSION_HEOPRESS_API_TOKEN}
x-site-id: {EXTENSION_HEOPRESS_SITE_ID}
{ "to": [...], "templateKey": "...", "variables": { ... } }
```

It declares only the capabilities it needs: `http:fetch` (to reach the core
endpoint) and `env:read` (to read the base URL + API token from
`EXTENSION_`-prefixed env).

## Run locally

1. Author a `teammate_invite` template in Studio → **Settings → Email** (or use
   the built-in fallback in HeoPress's invite flow).
2. Create a site-admin API key in Studio → **Settings → Access → API keys** —
   the `/api/v1/email/*` surface is gated by `requireSiteAdmin`.
3. Copy `.env.example` to `.env` and fill in the token + site id.
4. Install + run:

   ```bash
   pnpm install
   pnpm dev
   ```

5. Trigger a send:

   ```bash
   curl -X POST http://localhost:3006/extensions/email-setup/notify \
     -H 'Content-Type: application/json' \
     -d '{"to":["you@example.com"],"variables":{"name":"Sam"}}'
   ```

## Configure email transport (no UI required)

HeoPress's EmailService is configured entirely by env — no UI is needed to send:

| Variable | Purpose |
| --- | --- |
| `HEOPRESS_SMTP_URL` | SMTP connection string (Docker/Node runtime) |
| `HEOPRESS_MAIL_FROM` | Default envelope sender |
| `HEOPRESS_MAIL_REPLY_TO` | Optional default Reply-To |
| `HEOPRESS_MAIL_ENABLED` | Set to `false` to disable all sending |
| `HEOPRESS_RUNTIME=cloudflare` | Use MailChannels instead of SMTP |

See `docs/en/features/email-service.md` for the full reference.
