import { parentPort } from 'node:worker_threads';
import type { Liquid } from 'liquidjs';
import type { ThemeViewModel } from '@heopress/contracts/theme';
import { createThemeEngine, renderTemplate, type ThemeAsset } from './engine.ts';
import { postprocess, type PreviewPolicy, type SystemContent } from './postprocess.ts';

/**
 * A rendering worker (HeoPress P06 tasks 2.2, 2.6; design §3, R3, R21): one render at a time, no
 * environment, no database, no file system use — templates, page data and system content arrive in the
 * message. The pool terminates the worker on a timeout; a memory limit ends only this worker.
 * Engines are cached per theme version (versions are immutable), a bounded number of them.
 */

export interface RenderRequest {
  id: number;
  versionId: string;
  templates: Record<string, string>;
  assets: ThemeAsset[];
  assetBase?: string;
  preview?: PreviewPolicy;
  entry: string;
  vm: ThemeViewModel;
  system: SystemContent;
  /** The engine's own render-time limit, ms (the pool's wall clock stops what this does not). */
  renderLimitMs: number;
}

export type RenderReply = { id: number; ok: true; html: string } | { id: number; ok: false; code: string; message: string };
export type WorkerReady = { ready: true };

const MAX_ENGINES = 16;
const engines = new Map<string, Liquid>();

function engineFor(versionId: string, templates: Record<string, string>, assets: ThemeAsset[], assetBase = '/_theme/'): Liquid {
  // The same version renders with different asset URLs on the public site and in a preview.
  const key = `${assetBase}\u0000${versionId}`;
  let engine = engines.get(key);
  if (engine) {
    engines.delete(key);
  } else {
    engine = createThemeEngine(templates, { id: versionId, assets, assetBase });
    if (engines.size >= MAX_ENGINES) engines.delete(engines.keys().next().value!);
  }
  engines.set(key, engine);
  return engine;
}

async function handle(req: RenderRequest): Promise<void> {
  let reply: RenderReply;
  try {
    const engine = engineFor(req.versionId, req.templates, req.assets, req.assetBase);
    const out = await renderTemplate(engine, req.entry, req.vm, { renderLimitMs: req.renderLimitMs });
    reply = { id: req.id, ok: true, html: postprocess(out.html, out.slots, req.vm, req.system, { preview: req.preview }) };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    // A message only: no stack, no path leaves the worker.
    reply = { id: req.id, ok: false, code: typeof e.code === 'string' ? e.code : 'RENDER_ERROR', message: String(e.message ?? err).split('\n')[0]!.slice(0, 300) };
  }
  parentPort!.postMessage(reply);
}

parentPort!.on('message', (req: RenderRequest) => void handle(req));
// Loaded (engine, schema, parser): the pool sends jobs only from now on, so start-up never counts against a render.
parentPort!.postMessage({ ready: true } satisfies WorkerReady);
