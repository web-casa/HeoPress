---
version: 3
lastUpdated: 2026-08-30T09:36:15.719Z
sourceLang: en
contentHash: 644f0f4b2f32179b
codeVerified: 2026-08-30T09:36:15.719Z
codeVerifiedHash: 644f0f4b2f32179b
codeVerifiedClaims: 112
---

# User Management Best Practices

> **Audience:** operators and integrators wiring a public frontend (e.g.
> Next.js) to a HeoPress site where visitors register, log in, and read
> content — while staff manage that content in Studio.
>
> **TL;DR:** One global `users` table is fine and intended. What keeps it
> safe is the **authorization boundary between realms**, not separate
> tables. Self-service visitors get a least-privilege `subscriber` role
> (`appAccess: false`); staff are invite-only with Studio roles; session
> tokens carry an `aud` claim so a frontend token can never reach Studio.
> See **ADR-011** for the decision record.

---

## 1. The core question: shared table vs. separate realms

A frequent question: *"If frontend visitors register into the same table
as admins, isn't that dangerous?"*

There are two readings:

| Interpretation | Verdict |
|----------------|---------|
| Give self-registered users an **admin role** | ❌ Never. Catastrophic. |
| Store them in the **same `users` table**, different role | ✅ Fine — *with* strict realm separation |

The risk lives in the **authorization boundary**, not the table. HeoPress
keeps a single identity store and separates *realms* by role + token
audience. Benefits of one store: a single human identity (one person can
be staff on one site and a subscriber on another), uniform auth, no
duplicate-account drift.

### Realms at a glance

| Realm | Who | Role | `appAccess` | Onboarding | Auth |
|-------|-----|------|-------------|------------|------|
| **Staff** | editors, admins, teammates | `administrator`, `member` | `true` | Invite-only (`POST /users/invite`) | CF Access JWT, or password `/login` (Studio token) |
| **Frontend end-user** | public visitors / subscribers | `subscriber` | `false` | Public self-service (`POST /auth/register`) | password `/login` (frontend token) |
| **Integration** | server-to-server (ISR, build) | n/a (API key) | per attached policy | Admin creates API key | `Authorization: Bearer lbk_…` |

---

## 2. Data model (single identity store)

```
users (global)                 ← one row per human identity
  ├─ id (nanoid), email, passwordHash?, status (active|invited|suspended)
  └─ isBootstrap
user_sites (membership N–N)     ← which sites + the PRIMARY role there
  └─ (userId, siteId) → roleId
roles (per site)                ← administrator | member | subscriber | custom
  └─ adminAccess, appAccess, systemKey
policies → permissions          ← what a role can actually do (Policy DSL, ADR-008)
api_keys → api_key_roles/policies  ← integration principals, scoped per site
```

- Domain rule: every domain table has `site_id` and every query filters by
  it (Strict Rule #2). RLS (`withRls`) is the defense-in-depth backstop.
- **`subscriber`** is the least-privilege frontend role. It grants nothing
  until you attach content permissions to it (e.g. `articles::read WHERE
  status = 'published'`). It is created idempotently on first registration
  (`ensureSubscriberRole`), so existing instances need no backfill.

> ⚠️ **Never attach Studio/admin policies to `subscriber`.** That role's
> entire purpose is to be the safe floor for self-service signups.

---

## 3. Authentication methods

`withAuth` (`apps/cms/src/middleware/auth.ts`) tries, in order:

1. **Dev token** (`Bearer dev:<email>:<role>`) — local dev only, triple-gated.
2. **Cloudflare Access JWT** (`cf-access-jwt-assertion` header) — the
   primary **staff/Studio** flow in production.
3. **API key** (`Authorization: Bearer lbk_…`) — integration principals.
4. **Custom JWT** (`Authorization: Bearer <HS256>`) — issued by
   `POST /auth/login` for both staff (when not using CF Access) and
   frontend subscribers.

### Token audiences (`aud`)

Custom JWTs carry an `aud` claim pinned at sign time
(`services/auth/token-audience.ts`):

| `aud` | Meaning | Can reach Studio? | Access TTL | Refresh TTL |
|-------|---------|-------------------|-----------|-------------|
| `studio` | bootstrap admin or a role with `appAccess` | ✅ (still subject to `appAccess`/TFA) | `12h` (`STUDIO_SESSION_TTL`) | `30d` (`STUDIO_REFRESH_TTL`) |
| `frontend` | subscribers / appAccess-less roles | ❌ **hard-rejected by `withStudioAccess`** | `30d` (`FRONTEND_SESSION_TTL`) | `90d` (`FRONTEND_REFRESH_TTL`) |
| `email-verify` | one-shot registration link token | n/a (not a session token) | 24h (link) | — |
| `password-reset` | one-shot password-reset link token | n/a (not a session token) | 1h (link) | — |
| `mfa-challenge` | one-shot step-up token between password and TOTP (§4f) | n/a (not a session token) | 5m | — |

**Per-realm TTL** (`sessionTtlFor` / `refreshTtlFor`): the two realms no
longer share one lifetime — staff sessions are short (higher-value target,
cheap to re-auth), subscriber sessions are long (better UX, low risk). The
access JWT is the working credential; the refresh token (§4d) silently
renews it up to the refresh horizon. Overrides accept a compact duration
(`12h`, `30d`) or a number of seconds; a malformed value falls back to the
default so a typo can't break login.

The audience wall is **defense-in-depth**: even if a role were
misconfigured to grant `appAccess`, a `frontend` token is rejected before
the policy bundle is consulted.

---

## 4. Self-service registration flow (frontend visitors)

```
Visitor (Next.js)            CMS                              Email
     │  POST /auth/register   │                                 │
     │ {email,password,name}  │  rate-limit per IP (cache)       │
     │───────────────────────▶│  create user status=invited     │
     │                        │  bind subscriber role (server)   │
     │                        │  sign email-verify JWT ──────────▶ verification link
     │   202 (generic)        │  audit: user_registered          │
     │◀───────────────────────│                                 │
     │                                                          │
     │  click link → frontend reads ?token=…                    │
     │  POST /auth/verify-email {token}                         │
     │───────────────────────▶│  verify JWT, status→active       │
     │   {status:'verified'}  │  audit: email_verified           │
     │◀───────────────────────│                                 │
     │  POST /auth/login {email,password}                       │
     │───────────────────────▶│  LoginGuard + anomaly checks     │
     │  {token (aud=frontend)} │  status must be 'active'         │
     │◀───────────────────────│                                 │
     │  GET /items/articles  (Authorization: Bearer <token>)    │
```

### Endpoints

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /api/v1/auth/register` | public | Creates `subscriber`, `status=invited`. Per-IP rate-limited. Returns generic `202` (no enumeration). |
| `POST /api/v1/auth/verify-email` | public | Body `{token}` (or `?token=`). Flips `invited`→`active`. Idempotent (`already_verified`). |
| `POST /api/v1/auth/login` | public | Issues `frontend`/`studio` JWT. Gated on `status='active'`, LoginGuard, anomaly detector. |
| `POST /api/v1/auth/resend-verification` | public | Body `{email}`. Per-IP rate-limited. Generic `202`; re-emails the activation link only for a not-yet-active, password-based account (lost-email recovery). |
| `POST /api/v1/auth/forgot-password` | public | Body `{email}`. Per-IP rate-limited. Generic `202` (no enumeration); emails a reset link only for an active, password-based account. |
| `POST /api/v1/auth/reset-password` | public | Body `{token,password}`. Consumes a stateless `password-reset` token (1h TTL), sets the new password hash and ends every login of the user on every site (new session generation). |
| `POST /api/v1/auth/refresh` | public | Rotates the presented refresh token (cookie or body `{refreshToken}`) → fresh access JWT + rotated refresh token, with the login's `sid`, `authTime` and MFA status unchanged. Refused when the login has ended or the password changed since it began. Reuse of a rotated or revoked token ends the whole login, on every site. |
| `POST /api/v1/auth/logout` | public | Ends the login the presented refresh token belongs to — on every site it reached — and clears the cookie. Idempotent. |
| `POST /api/v1/me/change-password` | bearer | Body `{currentPassword,newPassword}`. Verifies current password, sets new hash and ends every login of the user on every site. |
| `GET /api/v1/me/sessions` | bearer | The caller's live logins (`id`, `createdAt`, `authTime`, `mfaVerified`, `ip`, `userAgent`, `current`). |
| `DELETE /api/v1/me/sessions/:id` | bearer | End one of the caller's own logins, on every site (another person's id: `404`). |
| `DELETE /api/v1/me/sessions` | bearer | End ALL of the caller's logins (every device, every site). |
| `GET /api/v1/auth/sites` | bearer (Studio session) | The sites the caller can use Studio on — each judged by its own effective permissions (roles and policies); the bootstrap admin: all sites. `{id, name, displayTitle, roleName, current, mfaRequired}`. API keys and frontend sessions: `403`. |
| `POST /api/v1/auth/switch-site` | bearer (Studio session) | Body `{siteId, refreshToken}` (the current site's refresh token). Extends the caller's login to that site: an access JWT and refresh token valid only there, same `sid`, `authTime` and MFA status, in the body (never as the cookie). Not a member, no Studio access or no such site: the same `403 SITE_NOT_ALLOWED`; destination requires MFA the login lacks: `403 MFA_REQUIRED`; ended login or a rotated token (reuse — ends the login): `401`. Rate-limited per person (30/min, fail-closed). Cloudflare Access: `409 NOT_NEEDED` (address the other site); trusted external issuers: `409 NOT_SUPPORTED`. |
| `GET /api/v1/auth/me` | bearer | Current principal incl. `isFrontendUser`. |

### Login sessions (HeoPress P04)

Every sign-in creates a **login session** (`lumibase_auth_sessions`): when the person authenticated, whether with MFA, and whether it has ended. Its refresh tokens — on the site signed in to and on each site the login is extended to by a site switch — and its access JWTs (claim `sid`) depend on it:

- every request with a session JWT checks that its login is live, so ending a login ends its access tokens at once, not at their expiry;
- a refresh token keeps the user's `token_version` from when the login began and is refused once a password change, reset or MFA change raises it;
- logout, reuse of a rotated refresh token, "log out of all devices", password change or reset end the login (or all logins) on every site;
- refresh and switching carry the login's `authTime` and MFA status unchanged.

Refresh tokens from before login sessions were revoked by the upgrade: everyone signs in once.

**In Studio**, each browser tab has its own current site and login; the session of each (login, site) is stored separately (localStorage, or the OS keychain in the desktop app). Renewals are coordinated between tabs with the Web Locks API — two tabs rotating the same refresh token would otherwise look like token theft and end the login — so Studio requires a browser with Web Locks (every current browser). Every request goes through one transport (`apps/studio/src/lib/http.ts`; ESLint forbids calling `fetch` elsewhere). Signing out ends the login on the server; if the server cannot be reached, Studio says that the session stays valid there until it expires. Settings → Security → *Sign out of all devices* ends every login of the account.

**Switching sites in Studio**: the header shows the current site; a person who can use Studio on several sites picks another there (sites requiring 2FA are marked). The switch holds new requests, waits for a renewal in progress and for saves in flight — up to 10 s; if a save is still pending, Studio says its result is unknown and asks whether to switch anyway (check it when you return; it is never repeated on the other site) — then prepares the other site's session: one of the same login already stored in this browser if it still renews, otherwise `POST /auth/switch-site`. Once that session is saved, the tab reloads Studio on the other site, so nothing of the previous site (requests, live updates, notifications, cached data) carries over. If anything fails, or the person does not continue, the tab stays on its site and its held requests go on; a destination requiring 2FA the login lacks offers signing in there. A session renewed by the server but not saved in this browser cannot be switched from (sign in again). Once the switch goes ahead, new token renewals wait for it (a renewal the old page could not save would leave a rotated token behind); every renewal — of the tab's own session or of a stored one — first marks the stored record as "renewal under way" (in the record itself, in localStorage or the OS keychain); only a saved new pair or the record's removal clears the mark, and a marked record is never read as a session. So a refresh token the server may have rotated without this browser saving the result (lost answer, failed save) is never presented again — which would end the whole login as reuse; that session needs a new sign-in instead. If the mark cannot be stored, the token is not presented (the switch exchanges instead); a renewal refused before rotation (`429`) lifts it. A renewal is given up after 20 s (its outcome is then unknown and the mark stays); loading a tab waits for a renewal under way in another tab (at most 25 s) so it loads the new pair; signing out first marks the login (or the record) as ended — one localStorage key each — so its records are never read as sessions again, even if a renewal finishing in another window writes one back; the records are then removed under their lock in the background (only while still marked, so a record written again since by a switch stays), and other tabs drop their copy as soon as the mark appears. The sign-out request itself is given up after 10 s (the server session is then reported as possibly still valid). Under Cloudflare Access there is nothing to exchange: the tab just addresses the other site (`apps/studio/src/lib/session/switch.ts`).

### Guardrails baked in

1. **Server-resolved role** — the request body cannot pick a role.
2. **Email verification** — inactive until verified; stateless `email-verify`
   JWT (24h), no token table, single-use via state transition.
3. **Per-IP rate limit** — `DEFAULT_REGISTRATION_RATE_LIMIT` (5/hour),
   best-effort, fails open on cache outage.
4. **Anti-enumeration** — identical `202` regardless of whether the email
   exists; password hashing only on the new-email path.

### Required configuration

| Env | Purpose |
|-----|---------|
| `JWT_SECRET` | Signs Custom JWTs **and** email-verify/reset tokens. Required. |
| `STUDIO_SESSION_TTL`, `FRONTEND_SESSION_TTL` | Optional per-realm access-token TTL (defaults `12h` / `30d`). |
| `STUDIO_REFRESH_TTL`, `FRONTEND_REFRESH_TTL` | Optional per-realm refresh-token TTL / login horizon (defaults `30d` / `90d`). |
| `REFRESH_COOKIE_SAMESITE`, `REFRESH_COOKIE_DOMAIN`, `REFRESH_COOKIE_SECURE` | Optional cross-domain refresh-cookie attributes (see §4d). |
| `HEOPRESS_SMTP_URL`, `HEOPRESS_MAIL_FROM` | Outbound verification email. Without it, the user stays `invited` (no link sent). |
| `CORS_ALLOWED_ORIGINS` | Must include your Next.js origin. |
| site `siteUrl` | Builds the `…/verify-email?token=` link in the email. |

---

## 4b. Granting subscribers read access to content

A freshly registered subscriber can log in but **sees nothing** — the
`subscriber` role is empty by design. Grant content read explicitly
(admin-only, `requireSiteAdmin`):

```
# Subscribers can read PUBLISHED articles (default publishedOnly=true)
POST /api/v1/users/subscriber-access
  { "collection": "articles" }

# All rows, only some fields:
POST /api/v1/users/subscriber-access
  { "collection": "pages", "publishedOnly": false, "fields": ["title","body"] }

GET    /api/v1/users/subscriber-access            # list current grants
DELETE /api/v1/users/subscriber-access/articles   # revoke
```

This attaches `read` permissions (Policy DSL) to a shared `subscriber`
policy bound to the role — `publishedOnly: true` compiles to the row-level
filter `{ status: { _eq: 'published' } }`. Grants take effect within ~60s
for already-authenticated subscribers (PermissionService bundle cache TTL).

> Use this instead of hand-editing policies in Studio when you just want
> "subscribers can read published X" — it is the minimal, audited primitive.

### Email templates

The verification, resend, and reset emails render a site DB template when
one exists (and is enabled), else a built-in inline fallback — so the flows
work out of the box. To customize, add an enabled email template with key:

| Key | Used by | Vars |
| --- | --- | --- |
| `email_verification` | register + resend-verification | `email`, `siteName`, `siteUrl`, `verifyUrl`, `token` |
| `password_reset` | forgot-password | `email`, `siteName`, `siteUrl`, `resetUrl`, `token` |

`verifyUrl`/`resetUrl` are empty when the site has no `siteUrl`; the link is
otherwise `${siteUrl}/verify-email?token=…` / `${siteUrl}/reset-password?token=…`.

## 4c. Forgot / reset password (end-users)

Self-service password recovery (distinct from the admin backup-code
recovery in the Setup Wizard):

```
POST /auth/forgot-password { email }      → generic 202; emails a 1h reset link
   (link → frontend /reset-password?token=…)
POST /auth/reset-password  { token, password }  → sets new password hash
```

The reset token is a stateless `password-reset` JWT (same pattern as
email verification). Trade-off: no per-token revocation and the link stays
valid for its 1h TTL; rotate `JWT_SECRET` to invalidate all outstanding
links. A successful reset **revokes all refresh tokens** for the user, so
existing sessions can no longer be silently renewed (any still-valid access
JWT survives only until its short TTL expires).

## 4d. Silent session renewal (refresh tokens)

The access JWT (`12h`/`30d`) is a short(er) working credential; a rotating,
server-tracked **refresh token** renews it without re-entering credentials,
up to the realm's refresh horizon (default `studio` 30d / `frontend` 90d,
env `STUDIO_REFRESH_TTL` / `FRONTEND_REFRESH_TTL`).

```
POST /auth/login    → { token, refreshToken, refreshTokenExpiresAt }  (+ httpOnly cookie)
POST /auth/refresh  → { token, refreshToken, refreshTokenExpiresAt }  (rotates; cookie or body)
POST /auth/logout   → revokes the family + clears the cookie
```

Security model (`services/auth/refresh-token.ts`, table `lumibase_refresh_tokens`):

- **Hashed at rest** — only `sha256(plaintext)` is stored; plaintext is
  returned once per login/refresh.
- **Rotation** — every refresh revokes the presented row and issues a
  successor in the same `familyId` (one-time use).
- **Reuse detection** — presenting an already-revoked token (theft signal)
  revokes the entire family, forcing a fresh login. A benign double-submit
  trips this too — the accepted cost of strict rotation.

**Transport — both:** the token is set as an `httpOnly` cookie (path-scoped
to `/api/v1/auth`) **and** returned in the body. Cookie suits browser apps;
the body value suits cross-origin SPAs/SDKs where the cookie may be dropped.

Cookie attributes are env-configurable for cross-domain setups
(`refreshCookieSettings`):

| Env | Default | Notes |
| --- | --- | --- |
| `REFRESH_COOKIE_SAMESITE` | `Lax` | Set `None` when the frontend is on a **different site** than the API (cross-site). `None` forces `Secure`. `Strict` also accepted. |
| `REFRESH_COOKIE_DOMAIN` | _(host-only)_ | e.g. `.example.com` to share the cookie across subdomains (`app.` ↔ `api.`). |
| `REFRESH_COOKIE_SECURE` | `true` | Set `false` only for local `http` dev. Ignored (forced `true`) when SameSite=`None`. |

For a cross-site browser frontend you must also: serve both over HTTPS, set
`CORS_ALLOWED_ORIGINS` to the exact frontend origin (no `*`), and have the
client send `credentials: 'include'`.

**CSRF:** because the cookie is ambient (auto-sent under `SameSite=None`),
`/refresh` and `/logout` require a custom **`X-HeoPress-Refresh`** header
when the token comes from the cookie. A cross-site simple request cannot set
a custom header (and doing so from JS triggers a CORS preflight the server
gates), so this neutralises CSRF for the cookie path. Body-token callers are
exempt. The header is allow-listed in CORS; cross-site clients must send it
(any non-empty value).

## 4e. Account self-service (authenticated)

For a logged-in user (`bearer`, under `/api/v1/me`):

- **Change password** — `POST /me/change-password` verifies the current
  password, sets the new hash, and revokes all refresh tokens so other
  sessions can't be silently renewed. SSO/passwordless accounts get
  `NO_PASSWORD`.
- **Session management** — now that refresh tokens are tracked,
  `GET /me/sessions` lists the caller's active sessions (no token material),
  `DELETE /me/sessions/:id` revokes one, and `DELETE /me/sessions` revokes
  all (logout everywhere). Expired/revoked rows are swept by the hourly
  prune (§4d).

## 4f. Two-factor authentication (TOTP)

Native, per-user, **opt-in**. Enrollment lives in Studio under
**Settings → Security**; there is no wizard step and no tenant-wide switch
(the existing `enforceTfa` policy flag is what makes 2FA mandatory for a
role). Only the `studio` realm is challenged — subscriber (`frontend`)
logins are unaffected.

**Login becomes two legs.** `POST /auth/login` verifies the password as
before, then, if the user has a verified TOTP credential, returns
`{ status: 'mfa_required', challengeToken, expiresIn }` instead of a session.
The client posts that token plus a code to `POST /auth/verify-totp`, which
returns the normal login payload with `amr: ["pwd", "totp"]`.

The challenge token is a 5-minute HS256 JWT on the `mfa-challenge` audience,
so `withAuth` will never accept it as a session; its `jti` is recorded in the
cache provider on use, so a captured token cannot be replayed. `verify-totp`
is a public path (the caller has no session yet) and is therefore listed in
the `withAuth`, `site-membership`, and `studio-access` public sets — the
handler derives `userId`/`siteId` from the signed challenge, never from
client input, and re-checks the challenge's `siteId` against the resolved
tenant. Attempts are rate-limited per user (10) and per IP (30) per 15 min.

**Where secrets live.** The base32 seed is written only as a KeyProvider AEAD
envelope (`lumibase_user_totp_credentials.secret_ciphertext` +
`secret_key_id`), so production enrollment requires `ENCRYPTION_KEY`. The
plaintext seed is returned exactly once, by `POST /me/tfa/setup`, and is not
readable afterwards. The eight recovery codes are shown once and persisted as
PBKDF2 hashes (`lumibase_user_totp_recovery_codes`), single-use, with the
consuming IP recorded. Replay inside the verify window is blocked by
`last_used_step`. `users.tfa` holds only non-secret enrollment state.

**Mutating 2FA needs step-up.** Setup, recovery-code regeneration, and
disable all require the current password; the latter two also require a second
factor — a live TOTP code, or, for disable only, a recovery code, so that a
user whose seed can no longer be decrypted can still remove the dead factor. Disabling bumps `tokenVersion` and revokes refresh tokens, so a
stolen session cannot quietly downgrade the account's protection. Enroll and
disable both write audit events (`mfa_enrolled` / `mfa_disabled`); failed
verifies write `mfa_verify_failed`. TOTP codes, seeds, recovery codes, and
challenge tokens are on the audit logger's drop list, so none of them can
reach the audit trail.

**Key lifecycle.** The seed is wrapped by whichever key was active at
enrollment, and the row pins that version in `secret_key_id`; decryption
resolves the key from the envelope. Two consequences operators get wrong: the
envelope migration (`POST /admin/encryption/envelope/migrate`) re-wraps item
fields only and never touches this table, so **an old key must stay configured
for as long as any seed references it**; and because one deployment-wide key
wraps every seed, **rotating after a key leak does not protect existing
enrollments** — those users must re-enroll. The AAD (`totp-secret|<userId>`)
prevents replaying one user's ciphertext under another id; it is not a
confidentiality boundary. Full procedures in
[Encryption key operations](../operations/encryption-keys.md).

**Multi-tenancy.** A TOTP credential belongs to the **identity**, not to a
site — the tables are keyed by `user_id` only, matching the single identity
store (§2) and the existing `lumibase_admin_backup_codes`. Enrolling once
protects the user's login on every site they belong to, which is the intended
behaviour; there is no per-site enrollment and nothing to isolate by
`site_id`. Tenant-scoped side effects still are: the audit events are written
with the request's `siteId`, and disable revokes refresh tokens for the
current site. Env knobs are deployment-wide: `ENCRYPTION_KEY` (required to
enroll) and `HEOPRESS_TOTP_ISSUER` (label in authenticator apps, default
`HeoPress`).

## 5. Staff onboarding (do NOT use self-service)

Staff are created **invite-only**:

```
POST /api/v1/users/invite     (requireSiteAdmin)
  { "email": "editor@acme.com", "roleId": "<member|administrator role id>" }
```

This creates/links the user with a Studio role (`appAccess: true`) and
sends a best-effort invite email. Enforce TFA on admin roles via a policy
with `enforceTfa: true` (`withStudioAccess` then requires a TFA-verified
session).

---

## 6. Frontend (Next.js) integration notes

- **Store the token** as an httpOnly, `Secure`, `SameSite` cookie set by
  your Next.js route handler — not in `localStorage` (XSS exfiltration).
- **Send the tenant**: include `X-HeoPress-Site: <siteId>` (or rely on
  subdomain resolution) on every CMS call.
- **Never call Studio APIs** (`/collections`, `/roles`, `/users`, …) from
  the public frontend — those require a `studio` token and `appAccess`; a
  `frontend` token is rejected by design.
- **Use an API key for build-time/ISR** server-to-server reads, not a user
  token; scope it to a read-only policy.
- **Token lifetime** is 24h; implement a refresh/re-login UX.

---

## 7. Exposing user management over MCP (future feasibility)

> Can this surface later be exposed via **MCP** (Model Context Protocol)?
> Evaluation below. [Inference] — a design assessment, not a shipped
> capability.

**Grounding:** HeoPress already ships an MCP server —
`packages/mcp-server` (`name: 'heopress'`, stdio transport). It exposes
**items / collections / fields** tools today and authenticates exactly the
way this evaluation recommends: a `HeoPressClient` carrying
`Authorization: Bearer <api key>` + `X-HeoPress-Site: <siteId>`
(`packages/mcp-server/src/client.ts`). So "exposing user management over
MCP" concretely means **adding a `tools/users.ts` alongside the existing
tool modules**, reusing the same API-key client — not building new infra.

**What MCP would be here:** an MCP *server* exposing user/role operations
as tools an AI agent (or external MCP client) can call.

### Recommended split

| Surface | MCP-exposable? | Rationale |
|---------|----------------|-----------|
| **Read** — list users, read roles/policies, audit queries | ✅ Low risk | Read-only, already admin-gated; maps cleanly to MCP tools. |
| **Management** — invite user, assign/revoke role, suspend, rotate API key | ⚠️ With strong gating | High-impact. Expose only behind an API key bound to an explicit admin policy, per-site scoped, and route privilege-changing calls through the HITL `ai_approvals` path. |
| **Public auth** — `register`, `login`, `verify-email` | ❌ Do not expose | These are *end-user credential flows*, not agent capabilities. An agent should never self-register accounts or handle user passwords. |

### Why it fits HeoPress cleanly

- **Capability + HITL already exist.** Strict Rule #4 requires skills with
  `schema:write`-class capability or `delete*` to go through `ai_approvals`
  first. User-mutation tools (assign admin role, delete user) are exactly
  the dangerous class — reuse that gate; do not invent a side channel.
- **Per-site scoping is native.** Every table is `site_id`-scoped and API
  keys are bound to one site, so an MCP tool inherits tenant isolation.
- **Audit is native.** `audit_log` already records `user_registered`,
  `email_verified`, `api_key_*`, role changes — MCP-initiated actions get
  the same provenance for free (set `actorEmail`/metadata to the agent).
- **Earned autonomy (L0–L4).** MCP user-management tools map onto the
  Content OS autonomy ladder: start at L1 (propose → human approves),
  promote to veto-window/autopilot only for low-risk ops (e.g. read,
  resend invite), never for role elevation.

### Hard constraints if/when implemented

1. **Never mint or elevate a principal without HITL.** Any tool that can
   grant `appAccess`/`adminAccess`, create an admin, or issue an API key
   MUST create an `ai_approvals` row first.
2. **Audience integrity.** MCP tools authenticate as an API-key principal
   (or `studio`), never by forging a user JWT; the `frontend` audience wall
   stays intact.
3. **No password handling.** MCP tools must not accept, store, or relay
   end-user passwords; verification/login stay HTTP-only.
4. **Rate + scope.** Bind the MCP server's API key to a narrow policy
   (e.g. `users::read` + `users::update` on `status`/`roleId` only) rather
   than admin bypass.

**Bottom line:** the *management* surface is a good future MCP candidate
because the safety primitives (capability gating, HITL, per-site scope,
audit, autonomy levels) are already in place — and the delivery vehicle
(`packages/mcp-server` + its API-key client) already exists, so the work is
a new `tools/users.ts` module plus an admin-scoped key, not new
infrastructure. The *public auth* surface should remain ordinary HTTP and
never become an agent tool.

---

## 8. Quick reference — files

| Concern | File |
|---------|------|
| Register / verify-email / resend-verification / login / forgot+reset password | `apps/cms/src/routes/auth.ts` |
| Subscriber content access endpoints | `apps/cms/src/routes/users.ts` |
| Auth methods + audience parsing | `apps/cms/src/middleware/auth.ts` |
| Studio access + frontend wall | `apps/cms/src/middleware/studio-access.ts` |
| Subscriber role provisioning | `apps/cms/src/services/auth/frontend-role.ts` |
| Subscriber content-read grants | `apps/cms/src/services/auth/subscriber-access.ts` |
| Token audiences + access/refresh TTL helpers | `apps/cms/src/services/auth/token-audience.ts` |
| Rotating refresh tokens (issue/rotate/revoke) | `apps/cms/src/services/auth/refresh-token.ts` (table `lumibase_refresh_tokens`) |
| Email-verify / password-reset tokens | `apps/cms/src/services/auth/{email-verification,password-reset}.ts` |
| Per-IP rate limit (register/resend/forgot) | `apps/cms/src/modules/auth/registration-guard.ts` |
| Verification / reset emails | `apps/cms/src/modules/email/{verify-email,password-reset}.ts` |
| Decision record | `docs/en/architecture/decisions/adr-011-user-management-realms.md` |

---

## 9. Hardening notes & known limitations

Verified fixes shipped with this feature (see CHANGELOG):

- **Single-use password-reset (H1).** `users.password_changed_at` (migration
  `0006`) is stamped on every reset/change; a reset token whose `iat`
  predates it is rejected (`isResetTokenStale`). A leaked or replayed link
  cannot set a second password, and issuing a newer reset invalidates older
  links.
- **Global unique email (H3).** Unique index on `lower(email)` (migration
  `0006`) is the DB backstop behind the check-then-insert in `/register`;
  a lost registration race surfaces as the same generic `202`.
- **Atomic refresh rotation (M1).** Rotation claims the row with a
  conditional `UPDATE … WHERE revoked_at IS NULL`; a concurrent loser is
  treated as reuse and the family is revoked.
- **Audience-pinned session verify (M5).** `verifyCustomJwt` requires
  `aud ∈ {studio, frontend}`; a single-purpose `email-verify`/`password-reset`
  JWT can never be replayed as a session token. Tokens minted before
  per-realm audiences existed are rejected → the holder re-authenticates.
- **`/refresh` re-checks realm (M4).** Membership is re-verified and the
  audience recomputed from the role's *current* `appAccess` on every renewal.

Known limitations — **tracked follow-ups, not yet fixed** (accept or address
before relying on them in a hostile deployment):

- **H2 — IP-based rate limiting off Cloudflare — fixed in HeoPress P03.**
  `extractClientIp` now reads the socket address on Node. Forwarding headers
  count only when the peer is listed in `HEOPRESS_TRUSTED_PROXIES`, and then the
  client is the rightmost `X-Forwarded-For` entry that is not a trusted proxy
  (entries further left are client-written). `CF-Connecting-IP` is not used: a
  reverse proxy passes a client-supplied one through. Behind Cloudflare, list
  Cloudflare's ranges and your proxy in `HEOPRESS_TRUSTED_PROXIES`.
- **M2 — no absolute session lifetime.** Refresh rotation grants a fresh TTL
  every hop, so a chain that refreshes at least once per refresh-TTL window
  lives indefinitely. Only a password change (which revokes all tokens) or
  explicit logout/session-revoke ends it. Add a family-origin cap if an
  absolute cap is required.
- **L2 — refresh cookie is host-scoped across tenants.** The
  `heopress_refresh` cookie uses one name per host; on a shared-host
  multi-tenant deployment, logging into site B overwrites site A's cookie
  (a subsequent site-A cookie `/refresh` then 401s and clears). Body-token
  transport is unaffected — cross-tenant SPAs should prefer it.

Operational note — the `lower(email)` unique index (`0006`) fails to create
if the `users` table already holds case-insensitive duplicate emails.
De-duplicate first:

```sql
SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
```
