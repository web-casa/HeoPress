# HeoPress Examples

This directory contains standalone, production-ready examples demonstrating how to build applications, handle events, and write extensions with HeoPress.

## Examples List

### 1. [Next.js Blog](./nextjs-blog)
A blog application built with Next.js (App Router, Server Components) that fetches data using `@heopress/sdk`.
- Demonstrates typed collections fetching via `createHeoPressClient` and `legacyRest`.
- Integrates typegen for compile-time safety.
- Implements Next.js dynamic caching & ISR.

### 2. [Hono Webhook Handler](./hono-webhook)
A webhook receiver built with Hono.js.
- Explains how to verify webhook signatures using HMAC-SHA256.
- Parses and processes type-safe payloads for items modification (create, update, delete).

### 3. [Color Picker Extension](./extension-color-picker)
A custom field extension for HeoPress Studio.
- Implements a modern color-picker UI.
- Communicates with the HeoPress Studio shell via postMessage.
- Uses `manifest.json` declaration for easy uploading.
- Built against the packed `@heopress/extension-sdk` (not monorepo sources) by
  `node scripts/verify-sdk-example.mjs` from the repository root.

### 4. [Email Setup Extension](./extension-email-setup)
An endpoint extension that sends email through HeoPress's built-in EmailService.
- Shows the split: the extension owns the trigger/UI; HeoPress owns transport + templates.
- Calls the core `POST /api/v1/email/send` with a `templateKey` — never talks SMTP itself.
- Declares minimal capabilities (`http:fetch`, `env:read`).

### 5. [Plugin Template](./plugin-template)
A hook-extension template that depends only on `@heopress/extension-sdk` (Apache-2.0).
- Imports only types from the SDK, so `dist/index.js` has no runtime dependency.
- `node scripts/verify-plugin-template.mjs` installs nothing but the packed SDK (offline), builds it
  with the workspace's pinned TypeScript and checks that no AGPL package is in its tree (CI job `plugin-template`).

---

## Getting Started

To run any of the examples, navigate to its directory, install dependencies, and configure environment variables.

Example:
```bash
cd examples/nextjs-blog
cp .env.example .env.local
pnpm install
pnpm dev
```
