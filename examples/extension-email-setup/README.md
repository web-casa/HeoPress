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
POST {baseUrl setting}/api/v1/email/send
Authorization: Bearer {secret heopress-api-token}
x-site-id: {siteId setting}
{ "to": [...], "templateKey": "...", "variables": { ... } }
```

It declares only what it needs: `ext:endpoints` (it mounts an endpoint), the
HeoPress host in `outboundHosts` (the only host `ctx.fetch` reaches) and the
secret `secrets:heopress-api-token` (read with `ctx.secrets.get`). Plugins have
no environment or database access.

## Run locally

1. Author a `teammate_invite` template in Studio → **Settings → Email** (or use
   the built-in fallback in HeoPress's invite flow).
2. Create a site-admin API key in Studio → **Settings → Access → API keys** —
   the `/api/v1/email/*` surface is gated by `requireSiteAdmin` — and store it
   as the plugin secret `heopress-api-token`.
3. Build (`pnpm build`), sign the bundle, and install it on the site, approving
   the capabilities the manifest requests (in development mode,
   `HEOPRESS_ENV=development`, an unsigned bundle is accepted).
4. Trigger a send:

   ```bash
   curl -X POST https://cms.example.com/api/v1/extensions/email-setup/notify \
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
