import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, findViolations } from '../check-removed-services.mjs';

test('code and config may not reference removed services; history may', () => {
  const files = {
    'packages/runtime/src/a.ts': "import Redis from 'ioredis';",
    'docker/docker-compose.yml': 'services:\n  redis:\n    image: redis:7-alpine',
    '.github/workflows/ci.yml': 'env:\n  REDIS_URL: redis://localhost',
    'docs/en/deployment/x.md': 'Set `IMGPROXY_KEY` first.',
    'docs/en/deployment/y.md': 'There is no Redis to operate.',
    'docs/decisions/ADR-0002.md': 'REDIS_URL is no longer required',
    'apps/cms/src/config/removed-services.ts': "REDIS_URL: 'Redis is no longer used'",
    'scripts/smoke.sh': 'run -e REDIS_URL=redis://x cms  # removed-services:allow',
  };
  const v = findViolations(Object.keys(files), (f) => files[f]);
  assert.deepEqual(v.map((x) => x.split(':')[0]), [
    'packages/runtime/src/a.ts',
    'docker/docker-compose.yml',
    '.github/workflows/ci.yml',
    'docs/en/deployment/x.md',
  ]);
  assert.equal(classify('openspec/changes/p03/tasks.md'), null);
  assert.equal(classify('pnpm-lock.yaml'), null);
});
