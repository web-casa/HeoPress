---
version: 4
lastUpdated: 2026-09-08T21:00:34.356Z
sourceLang: en
contentHash: 4575c3d9c04845cc
codeVerified: 2026-09-10T19:51:39.334Z
codeVerifiedHash: 4575c3d9c04845cc
codeVerifiedClaims: 10
---

# Testing Guide

HeoPress uses **Vitest** for unit and integration tests across the monorepo. This guide covers testing conventions, patterns, and how to write good tests for HeoPress.

## Running tests

```bash
# Run all tests
pnpm test

# Run tests in a specific package
pnpm -F @heopress/cms test

# Run in watch mode
pnpm -F @heopress/cms test --watch

# Run with coverage (thresholds assume a database: see "Coverage thresholds")
pnpm --filter @heopress/cms exec vitest --run --coverage

# Run a specific test file
pnpm -F @heopress/cms test src/services/__tests__/ai-harness-execute.test.ts
```

## Test types

### Unit tests

Test individual functions and classes in isolation. Mock all external dependencies.

Location: `src/**/__tests__/*.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { AISecureHarness } from '../ai-harness'
import { mockSkills } from './__mocks__/skills'

describe('AISecureHarness', () => {
  describe('evaluateRisk', () => {
    it('marks schema:write skills as dangerous', () => {
      const harness = new AISecureHarness({ skills: mockSkills })
      const result = harness.evaluateRisk('createCollection')
      expect(result.isDangerous).toBe(true)
    })

    it('marks read-only skills as safe', () => {
      const harness = new AISecureHarness({ skills: mockSkills })
      const result = harness.evaluateRisk('listCollections')
      expect(result.isDangerous).toBe(false)
    })
  })
})
```

### Property-based tests

For logic that must hold across many inputs, use **fast-check** (already used in the codebase):

```typescript
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { evaluateConditions } from '../permission-dsl'

describe('evaluateConditions', () => {
  it('never throws on arbitrary filter input (Property 1)', () => {
    fc.assert(
      fc.property(
        fc.record({ status: fc.string(), author: fc.string() }),  // arbitrary item
        fc.anything(),                                              // arbitrary conditions
        (item, conditions) => {
          // Should return a boolean, never throw
          const result = evaluateConditions(conditions, item)
          expect(typeof result).toBe('boolean')
        }
      ),
      { numRuns: 100 }
    )
  })
})
```

Properties are named `Property N` in the test file — see `src/services/__tests__/` for examples.

### Integration tests

Test route handlers with a real Hono app instance and mocked services:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { testClient } from 'hono/testing'
import { buildApp } from '../../index'
import { mockRuntime } from './__mocks__/runtime'

describe('POST /api/v1/ai/chat', () => {
  let client: ReturnType<typeof testClient>

  beforeAll(() => {
    const app = buildApp({ runtime: mockRuntime })
    client = testClient(app)
  })

  it('returns executed for safe skills', async () => {
    const res = await client.api.v1.ai.chat.$post({
      json: { message: 'list all collections' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('executed')
  })

  it('returns pending_approval for dangerous skills', async () => {
    const res = await client.api.v1.ai.chat.$post({
      json: { message: 'delete all articles' },
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data.status).toBe('pending_approval')
    expect(body.data.approvalId).toBeTruthy()
  })
})
```

### DB-backed integration tests

Some suites exercise real SQL against a live Postgres (drift→goal transitions, fingerprint dedupe, partial unique indexes, tenant scoping). They share one harness, `apps/cms/src/__tests__/helpers/db-harness.ts`, and it draws a distinction the older `canConnect` pattern could not:

| Situation | Outcome | Why |
|---|---|---|
| `DATABASE_URL` absent | **skipped** | Nobody asked for DB tests. |
| `DATABASE_URL` set but unreachable | **failed** | Someone asked for DB tests and did not get them. |

That second row is the point. The previous convention gated every hook and test with `if (!canConnect) return`, and **an early return is a passing test** — so a run against a database that was not there reported `20 passed / 76 passed / exit 0`, indistinguishable from a real run. Write suites like this instead:

```typescript
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness'

describe.skipIf(!hasDbIntegrationUrl)('My DB integration', () => {
  let db: Database

  beforeAll(async () => {
    // Throws if the database does not answer — the suite fails, never skips.
    db = await connectDbIntegration('my-suite')
  })

  afterAll(async () => {
    if (!db) return // beforeAll may have thrown
    // …cleanup
  })

  beforeEach(async () => {
    // Reset shared tables; cascade from `sites` clears tenant-scoped rows.
    await db.delete(sites).where(/* this suite's site ids */)
  })

  it('does the thing', async () => {
    // No connection guard: reaching here means the database answered.
  })
})
```

Two rules follow from it:

- `describe.skipIf(!hasDbIntegrationUrl)` on the **top-level** describe, so vitest prints a real `skipped` instead of counting assertions that never ran.
- No `if (!canConnect) return` anywhere. A source-scan tripwire (`db-integration-guard.wiring.test.ts`) fails the build on the old shape, and on any `*.db.integration.test.ts` that does not import the harness — a suite can only *forget* the harness, which no behavioural test can observe.

An ungated top-level `describe` is allowed only when it touches no database at all (e.g. a pure helper living beside the suite); the tripwire asserts exactly that.

Run them against a local database:

```bash
# Start Postgres (override the port if 5432 is taken locally)
POSTGRES_PORT=5433 docker compose -f docker/docker-compose.yml up -d postgres

# Apply all migrations to the fresh database
DATABASE_URL="postgres://heopress:heopress_dev@localhost:5433/heopress" \
  pnpm -F @heopress/database migrate

# Run the suite with the database wired in
DATABASE_URL="postgres://heopress:heopress_dev@localhost:5433/heopress" \
  pnpm -F @heopress/cms test
```

> **A stale `DATABASE_URL` now fails.** If your shell exports `DATABASE_URL` for a database that is no longer running, DB suites go **red** rather than quietly green. That is deliberate — it is the failure this harness exists to remove. Unset the variable to skip DB suites, or start the database.

> **File parallelism.** When `DATABASE_URL` is set, `apps/cms/vitest.config.ts` and `packages/database/vitest.config.ts` disable `fileParallelism` automatically. Integration suites share one database and reset shared tables in `beforeEach`, so running their files concurrently lets one file's reset wipe another's fixtures mid-test. Without a database the tests skip and the rest of the suite runs fully parallel.

### Cross-site tests

`apps/cms/src/__tests__/helpers/cross-site-fixture.ts` builds two sites that share every name — collection, slug, path, theme name, file name — with users of only A, only B and both, scoped API keys (which are also MCP tokens) and real session tokens. A test drives the whole app (`app.request(path, init, env)`) with `fixture.headers(site, token)`; `cross-site-writes.db.integration.test.ts` is the example. New surfaces add their cross-site case there.

### Studio browser scenarios (Playwright)

`apps/studio/e2e/` runs in Chromium on the **build output**: the CMS bundle serves the built Studio from one origin, as Docker does. The global setup resets the database, runs first-time setup through the API and seeds two sites (`apps/cms/scripts/e2e-studio-seed.ts`), so use a disposable database:

```bash
pnpm --filter @heopress/studio build && pnpm --filter @heopress/cms build
pnpm --filter @heopress/studio exec playwright install chromium
DATABASE_URL=<disposable db> HEOPRESS_E2E_DISPOSABLE_DB=true pnpm --filter @heopress/studio e2e
```

Failures keep a trace under `apps/studio/e2e-results/` (`npx playwright show-trace <trace.zip>`). CI runs them in the `studio-e2e` job.

## Test conventions

### What to test

| Code | Test type | Coverage target |
|------|-----------|-----------------|
| Business logic (services) | Unit | All branches |
| Permission evaluation | Property-based | ≥100 iterations |
| Route handlers | Integration | Happy path + error cases |
| Schema validation | Unit | Valid + invalid inputs |
| Utility functions | Unit | All edge cases |

### What NOT to test

- Drizzle ORM itself (trust the library)
- Logto JWT validation (trust the library)
- CSS styles (visual regression tests are out of scope)

### Mocking patterns

**Mock the runtime (not the database):**

```typescript
// ✓ Good — mock at the runtime abstraction layer
const mockCache: CacheProvider = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  invalidateByTag: vi.fn().mockResolvedValue(undefined),
}
```

**Mock external HTTP calls:**

```typescript
import { http, HttpResponse } from 'msw'
import { server } from './__mocks__/server'  // MSW server

server.use(
  http.post('https://api.openai.com/v1/chat/completions', () => {
    return HttpResponse.json({ choices: [{ message: { content: 'mocked' } }] })
  })
)
```

### Test file naming

```
src/services/__tests__/ai-harness-execute.test.ts      # Unit tests
src/services/__tests__/ai-harness-risk.property.test.ts  # Property tests
src/routes/__tests__/ai-chat-validation.property.test.ts # Route property tests
src/__tests__/ai-integration.test.ts                   # Integration tests
```

## Quality commands

Three commands run the checks a change has to pass (`scripts/quality.mjs`, ADR-0017):

```bash
pnpm quality:fast      # workspace scripts, typecheck, lint, unit tests
pnpm quality:pr        # the PR gate: + check:all, build, and the database suites with coverage thresholds
pnpm quality:release   # before a release: + OpenSpec strict, security scans, image runtime acceptance, Trivy
```

Every tier first checks the workspaces: each one is declared in `WORKSPACES` in `scripts/quality.mjs`, has the
scripts declared for it, has a `test` script whenever it holds test files, and its sources are in the root ESLint
run. A missing or placeholder script fails the command instead of being skipped (Turbo would silently skip a
workspace without the script). A step whose prerequisite is missing — a database, `gitleaks`, `trivy`, Docker —
fails as well; it is never reported as passed.

`quality:pr` needs a disposable PostgreSQL 18: `DATABASE_OWNER_URL` (the owner that migrated it) and
`DATABASE_URL` (the application role). `node scripts/quality.mjs pr --group static` runs the part without a
database. `--list` prints the steps of a tier.

`quality:release` scans what would be published, not the working tree: the secret scan runs
`scripts/public-export.mjs` on `HEAD` (commit first) and then gitleaks over the export, as `security.yml` does in
the public repository. The image steps build the images with the tag `HEOPRESS_QUALITY_IMAGE_TAG` (default
`quality`) and run the image runtime acceptance (`docker/scripts/accept-image-runtime.sh`) and Trivy on them.

## Coverage thresholds

The CMS suites run with coverage in the `db` group of `quality:pr`, against a real database, so that the critical
modules are measured with the tests that exercise them. `apps/cms/coverage-thresholds.json` lists the critical
modules (permissions, site scope, approvals, budgets, state machines) by file and the baseline of each (lines,
branches, functions, statements), plus a baseline for all CMS code together; `apps/cms/vitest.config.ts` turns them
into Vitest thresholds with an explicit `coverage.include`. A run below a baseline fails.

Baselines never go down. A full run differs from the next by a few branches (timing-dependent paths such as
`state-reconciliation.ts`), so a baseline is the lowest value of at least two full runs, rounded down to a whole
point. After adding tests, run the suites twice and raise the baselines:

```bash
node scripts/coverage-baseline.mjs                                   # last run vs baseline, per module
node scripts/coverage-baseline.mjs --summary run1.json --summary run2.json --update
                                                                     # raise to the lowest of the runs; never lowers
```

Each CI run keeps its summary as the `cms-coverage` artifact.

The target for the critical modules is 90% lines and 85% branches. Coverage does not replace the invariant tests:
a site-isolation leak, a lost event or a reused approval is a failure whatever the percentage says.

## CI

`.github/workflows/ci.yml` runs `quality:pr` in two jobs: `checks` runs the `static` group and `db-suites` runs the
`db` group with PostgreSQL 18, an S3-compatible store and MeiliSearch, and keeps
`apps/cms/coverage/coverage-summary.json` as an artifact. `scripts/__tests__/quality.test.mjs` fails if the
workflow stops running a group of `quality:pr`. The `image-runtime` job runs the image runtime acceptance
(`docker/scripts/accept-image-runtime.sh`).

## k6 performance tests

Load scripts live in `apps/cms/k6/`. They use [Grafana k6](https://k6.io/) and were gated in upstream CI by a workflow now archived at `docs/legacy/upstream/workflows/perf-k6.yml`; HeoPress CI does not run them yet.

### Local workflow

```bash
# 1. Start dependencies
docker compose -f docker/docker-compose.yml up -d postgres

# 2. Migrate + seed (CI uses SEED_ITEMS=1000 per collection; full baseline = 100000)
DATABASE_URL=postgres://heopress:heopress_dev@localhost:5432/heopress \
  pnpm -F @heopress/database migrate
SEED_ITEMS=1000 DATABASE_URL=postgres://heopress:heopress_dev@localhost:5432/heopress \
  pnpm exec tsx apps/cms/k6/seed.ts

# 3. Start CMS
DATABASE_URL=postgres://heopress:heopress_dev@localhost:5432/heopress \
  JWT_SECRET=local-dev \
  pnpm -F @heopress/cms exec tsx src/serve.ts

# 4. Run scripts (install k6: https://k6.io/docs/get-started/installation/)
k6 run --env BASE_URL=http://localhost:1989 apps/cms/k6/smoke.js
k6 run --env BASE_URL=http://localhost:1989 \
     --env SITE_ID=site_load_a \
     --env COLLECTION=articles \
     apps/cms/k6/load-deliver.js
```

Baseline numbers are stored under `docs/legacy/kiro-specs/high-load-cache-readiness/baseline/` as JSON (config + p50/p95/p99 + custom metrics). Re-run after meaningful cache or infra changes and commit a new dated file — do not edit old baselines in place.

### Changing thresholds

Thresholds are defined in each script's `export const options.thresholds` block (e.g. `load-deliver.js`). Change them only when:

1. You have a new baseline JSON proving the old bar is unrealistic, or
2. An intentional perf regression is accepted and recorded in the roadmap §2 table.

For CI, keep thresholds at or below **baseline × 1.2** (design §13.3). After raising a threshold, update the corresponding baseline notes file and mention the change in the PR.

The `perf-k6` workflow uploads `load-deliver-summary.json` as an artifact on full runs. The `validate-scripts` job always runs `k6 inspect` so broken scripts fail fast without Docker.

