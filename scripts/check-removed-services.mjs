import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Removed-services tripwire (HeoPress P03 task 7.2, ADR-0002).
 *
 * Redis, BullMQ and imgproxy are gone: cache, queue, scheduled jobs and rate
 * limits run on PostgreSQL and images are transformed in process. This check
 * keeps them from creeping back into what configures or runs HeoPress:
 *
 *   - code, compose files, Dockerfiles, env examples, CI workflows and
 *     scripts must not mention REDIS_URL / REDIS_HOST / IMGPROXY_* /
 *     ioredis / bullmq, or a redis or imgproxy image;
 *   - current docs (docs/en, README) must not tell anyone to set REDIS_URL or
 *     IMGPROXY_* variables.
 *
 * History stays as it is: ADRs, the roadmap, review and handoff records,
 * legacy specs, OpenSpec changes and the changelog are not checked. The one
 * place allowed to name the variables is the startup refusal that rejects
 * them (`apps/cms/src/config/removed-services.ts`) and its test; a line that
 * uses one on purpose — the CI step proving that such a setting stops startup —
 * carries `removed-services:allow`.
 */

const CODE_PATTERN = /\b(REDIS_URL|REDIS_HOST|IMGPROXY_[A-Z]+|ioredis|bullmq)\b|image:\s*["']?(redis|darthsim\/imgproxy)/i;
const DOC_PATTERN = /\b(REDIS_URL|REDIS_HOST|IMGPROXY_[A-Z]+)\b/;

const ALLOWED = new Set([
  'apps/cms/src/config/removed-services.ts',
  'apps/cms/src/config/__tests__/removed-services.test.ts',
  'scripts/check-removed-services.mjs',
  'scripts/__tests__/check-removed-services.test.mjs',
]);

const HISTORICAL = [
  /^docs\/(?!en\/)/, // docs/decisions, docs/handoffs, docs/legacy, docs/review-agent, docs/ROADMAP.md, …
  /^docs\/en\/architecture\/decisions\//,
  /^docs\/en\/roadmap\//,
  /^openspec\//,
  /^CHANGELOG/,
];

export function classify(file) {
  if (ALLOWED.has(file) || HISTORICAL.some((re) => re.test(file))) return null;
  if (/^(docs\/en\/|README)/.test(file) && file.endsWith('.md')) return 'doc';
  if (/\.(ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|sh|env|example|toml)$|Dockerfile/.test(file) || /(^|\/)\.env/.test(file)) {
    if (file === 'pnpm-lock.yaml') return null;
    return 'code';
  }
  return null;
}

export function findViolations(files, read) {
  const out = [];
  for (const file of files) {
    const kind = classify(file);
    if (!kind) continue;
    const pattern = kind === 'doc' ? DOC_PATTERN : CODE_PATTERN;
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line) && !line.includes('removed-services:allow')) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
  }
  return out;
}

function main() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const violations = findViolations(files, (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  });
  if (violations.length) {
    console.error(`[removed-services] ${violations.length} reference(s) to removed services (Redis, BullMQ, imgproxy):`);
    for (const v of violations) console.error(`  ✖ ${v}`);
    console.error('Remove them: these services are not used since P03 (ADR-0002).');
    process.exit(1);
  }
  console.log('[removed-services] ok');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
