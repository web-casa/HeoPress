import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ABANDONED_QUEUES, QUEUE_REGISTRY, type QueueProvider } from '@heopress/runtime';
import { registerAgentRunWorker } from '../services/agent-run-worker';
import { registerRevalidationWorker } from '../services/content-invalidation';
import { registerAuditLogWorker, setAuditLogQueue } from '../modules/audit/worker';
import { registerEventConsumers } from '../modules/events/consumer-worker';
import { registerFlowEventWorker } from '../services/flow-dispatch';
import { registerFlowRunsWorker } from '../services/flow-run-service';
import { registerVetoCommitWorker } from '../services/veto-commit-worker';
import { registerPluginJobWorker } from '../extensions/runtime/jobs';
import { registerSchedulerWorker } from '../services/scheduler-worker';
import { registerIngestWorker } from '../services/ingest/source-worker';
import { installIngestRunner } from '../services/ingest/url-runner';
import { registerStatusPoller } from '../services/deployment/status-poller';
import { registerEnvelopeMigrationWorker } from '../services/envelope-migration-worker';
import { registerMaterializeRefreshWorker } from '../services/materialize-worker';
import { registerTranslationJobWorker } from '../services/translation-job-worker';

/**
 * Every queued job has a consumer (HeoPress P14 task 5.2, design D5; spec platform/infrastructure-adapters
 * "入队的任务必有消费者"):
 *
 *   1. the worker role's registration functions, run against a queue that records `process` calls, register a
 *      consumer for every queue of `QUEUE_REGISTRY` (packages/runtime/src/queue-registry.ts), and only for those;
 *   2. each of those functions is called by the worker entry (`serve.ts`), and the list below holds every function
 *      of the source that registers a consumer (a static scan of `.process(` finds no queue the list misses);
 *   3. every `.enqueue(` in the server source names a registered queue, by a string literal or a constant whose value
 *      is one. A new queue without a consumer fails here, naming the queue and the file.
 *
 * `PgBossQueueProvider.enqueue` refuses unregistered names at run time as well (postgres-queue.db.test.ts).
 *
 * Evidence class: the real registration functions with a recording queue (no broker), and a source scan of the files.
 */

const REPO = join(__dirname, '..', '..', '..', '..');
const CMS_SRC = join(REPO, 'apps/cms/src');
/** Server code that may enqueue (the plugin SDKs only see `ctx.jobs.enqueue`, which is excluded below). */
const ENQUEUE_ROOTS = ['apps/cms/src', 'packages/runtime/src', 'apps/site-classic/src', 'packages/mcp-server/src'];

/** Receivers of an `.enqueue(` that is not `QueueProvider.enqueue`. */
const OTHER_ENQUEUE_RECEIVERS: Record<string, string> = {
  controller: 'ReadableStream controller (streamed responses)',
  jobs: "a plugin's `ctx.jobs.enqueue(jobName, payload)`: the host puts it on `plugin-jobs` (extensions/runtime/jobs.ts)",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist' || entry === 'test-utils') continue;
      out.push(...sourceFiles(abs));
    } else if (/\.(c|m)?tsx?$/.test(entry) && !/\.(test|spec)\.(c|m)?tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** Source with comments blanked out (line count kept), so a commented call neither counts nor hides one. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));
}

/** `const NAME = 'value'` declarations of the given files: how a queue constant resolves. */
function stringConstants(files: Array<{ file: string; text: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { text } of files) {
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^'\n]+)'/g)) {
      const set = out.get(m[1]!) ?? new Set<string>();
      set.add(m[2]!);
      out.set(m[1]!, set);
    }
  }
  return out;
}

interface QueueUse {
  file: string;
  line: number;
  /** The first argument as written. */
  arg: string;
  /** The queue names it resolves to (empty: not resolvable). */
  names: string[];
}

function resolveArg(arg: string, constants: Map<string, Set<string>>): string[] {
  const literal = /^'([^']*)'$|^"([^"]*)"$/.exec(arg);
  if (literal) return [literal[1] ?? literal[2]!];
  return [...(constants.get(arg) ?? [])];
}

/** Every `QueueProvider.enqueue(` call of the files, with its queue argument. */
function enqueueUses(files: Array<{ file: string; text: string }>, constants: Map<string, Set<string>>): QueueUse[] {
  const uses: QueueUse[] = [];
  for (const { file, text } of files) {
    const src = code(text);
    for (const m of src.matchAll(/\.\s*enqueue\s*(?:<[^>()]*>)?\(\s*([^,)\s]+)/g)) {
      // The receiver: the identifier right before the dot (`queue`, `queue!`, `queue?`, `jobs`, `controller`).
      const receiver = /([\w$]+)[!?]?\s*$/.exec(src.slice(Math.max(0, m.index - 80), m.index))?.[1];
      if (receiver && receiver in OTHER_ENQUEUE_RECEIVERS) continue;
      const arg = m[1]!.trim();
      uses.push({ file, line: src.slice(0, m.index).split('\n').length, arg, names: resolveArg(arg, constants) });
    }
  }
  return uses;
}

/** Every `.process(` call of the files, with its queue argument. */
function processUses(files: Array<{ file: string; text: string }>, constants: Map<string, Set<string>>): QueueUse[] {
  const uses: QueueUse[] = [];
  for (const { file, text } of files) {
    const src = code(text);
    for (const m of src.matchAll(/\.\s*process\s*(?:<[^>()]*>)?\(\s*([A-Z][A-Z0-9_]*|'[^']*')\s*,/g)) {
      uses.push({ file, line: src.slice(0, m.index).split('\n').length, arg: m[1]!, names: resolveArg(m[1]!, constants) });
    }
  }
  return uses;
}

const read = (roots: string[]) =>
  roots.flatMap((root) => sourceFiles(join(REPO, root))).map((abs) => ({ file: relative(REPO, abs), text: readFileSync(abs, 'utf8') }));

const registered = new Set<string>(Object.keys(QUEUE_REGISTRY));

/** A queue that records each `process` registration and accepts nothing else. */
function recordingQueue(): { queue: QueueProvider; consumed: string[] } {
  const consumed: string[] = [];
  const queue: QueueProvider = {
    enqueue: async () => {
      throw new Error('registration must not enqueue');
    },
    process: (name) => {
      consumed.push(name);
    },
    getStatus: async () => null,
  };
  return { queue, consumed };
}

/**
 * The worker role's consumer registrations, by the function `serve.ts` calls. Dependencies other than the queue are
 * placeholders: registering only hands a handler to the queue.
 */
const db = {} as never;
const REGISTRATIONS: Record<string, (queue: QueueProvider) => unknown> = {
  registerAgentRunWorker: (queue) => registerAgentRunWorker({ db, queue } as never),
  registerRevalidationWorker: (queue) => registerRevalidationWorker({ db, queue }),
  registerAuditLogWorker: (queue) => registerAuditLogWorker({ db, queue }),
  registerEventConsumers: (queue) => registerEventConsumers({ db, queue, consumers: async () => [], tickMs: 3_600_000 } as never),
  registerFlowEventWorker: (queue) => registerFlowEventWorker({ db, queue } as never),
  registerFlowRunsWorker: (queue) => registerFlowRunsWorker({ db, queue } as never),
  registerVetoCommitWorker: (queue) => registerVetoCommitWorker({ db, queue } as never),
  registerPluginJobWorker: (queue) => registerPluginJobWorker(queue, {} as never),
  registerSchedulerWorker: (queue) => registerSchedulerWorker({ db, queue } as never),
  registerIngestWorker: (queue) => registerIngestWorker({ db, queue }),
  installIngestRunner: (queue) => installIngestRunner({ db, queue } as never),
  registerStatusPoller: (queue) => registerStatusPoller({ db, queue } as never),
  registerEnvelopeMigrationWorker: (queue) => registerEnvelopeMigrationWorker({ db, queue } as never),
  registerMaterializeRefreshWorker: (queue) => registerMaterializeRefreshWorker({ db, queue }),
  registerTranslationJobWorker: (queue) => registerTranslationJobWorker({ db, queue, gateway: {} as never }),
};

describe('queue consumers (P14 task 5.2)', () => {
  const stops: Array<() => void> = [];
  afterAll(() => {
    for (const stop of stops) stop();
    setAuditLogQueue(undefined);
  });

  let consumers: Set<string> | undefined;
  const consumersOf = (): Set<string> => {
    if (consumers) return consumers;
    const { queue, consumed } = recordingQueue();
    for (const register of Object.values(REGISTRATIONS)) {
      const out = register(queue);
      if (typeof out === 'function') stops.push(out as () => void);
    }
    return (consumers = new Set(consumed));
  };

  it('the worker registrations consume every registered queue, and only registered ones', () => {
    const consumed = consumersOf();
    expect([...registered].filter((name) => !consumed.has(name)), 'registered queues without a consumer').toEqual([]);
    expect([...consumed].filter((name) => !registered.has(name)), 'consumers of queues missing from the registry').toEqual([]);
  });

  it('serve.ts calls every registration, and the list holds every consumer of the source', () => {
    const serve = code(readFileSync(join(CMS_SRC, 'serve.ts'), 'utf8'));
    expect(Object.keys(REGISTRATIONS).filter((fn) => !new RegExp(`\\b${fn}\\(`).test(serve)), 'registrations serve.ts never calls').toEqual([]);

    const files = read(['apps/cms/src']);
    const uses = processUses(files, stringConstants(files));
    expect(uses.length).toBeGreaterThanOrEqual(registered.size);
    expect(uses.filter((u) => u.names.length === 0), 'a `.process(` whose queue does not resolve').toEqual([]);
    const consumed = consumersOf();
    expect(uses.filter((u) => u.names.some((n) => !consumed.has(n))), 'consumers in the source that REGISTRATIONS misses').toEqual([]);
  });

  it('every enqueue in the server source names a registered queue', () => {
    const files = read(ENQUEUE_ROOTS);
    const uses = enqueueUses(files, stringConstants(files));
    // The scan sees the known call sites (a regex that stopped matching would pass vacuously).
    const seen = new Set(uses.flatMap((u) => u.names));
    for (const name of ['agent-runs', 'materialize-refresh', 'plugin-jobs', 'ingest-fetch', 'cdc-dispatch', 'flow-events']) expect(seen).toContain(name);
    const bad = uses.filter((u) => u.names.length === 0 || u.names.some((n) => !registered.has(n)));
    expect(bad.map((u) => `${u.file}:${u.line} enqueue(${u.arg}) → ${u.names.join(', ') || 'unresolved'}`)).toEqual([]);
  });

  it('control: an enqueue to a queue nobody consumes is reported with its file and queue', () => {
    const fixture = [
      {
        file: 'fixture.ts',
        text: [
          "const THUMBS = 'media-processing';",
          "await queue.enqueue('media-processing', 'generate-thumbnails', {});",
          'await c.get(\'runtime\').queue?.enqueue(THUMBS, \'x\', {});',
          'await deps.queue!.enqueue<Job>(UNKNOWN_QUEUE, \'x\', {});',
          "// queue.enqueue('commented-out', 'x', {});",
          "controller.enqueue(chunk); ctx.jobs.enqueue('relink', {});",
          "await queue.enqueue('agent-runs', 'execute', {});",
        ].join('\n'),
      },
    ];
    const uses = enqueueUses(fixture, stringConstants(fixture));
    expect(uses.map((u) => [u.line, u.arg, u.names])).toEqual([
      [2, "'media-processing'", ['media-processing']],
      [3, 'THUMBS', ['media-processing']],
      [4, 'UNKNOWN_QUEUE', []],
      [7, "'agent-runs'", ['agent-runs']],
    ]);
    expect(uses.filter((u) => u.names.length === 0 || u.names.some((n) => !registered.has(n)))).toHaveLength(3);
  });

  it('no abandoned queue is registered again', () => {
    expect(ABANDONED_QUEUES.filter((name) => registered.has(name))).toEqual([]);
  });
});
