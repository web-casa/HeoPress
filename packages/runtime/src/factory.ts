// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { RuntimeContext } from './interfaces';
import { createDockerRuntime } from './adapters/docker';

/**
 * Creates the Node.js (Docker) RuntimeContext. `HEOPRESS_RUNTIME` may only be
 * unset or `docker`; any other value is a configuration error.
 *
 * @param env - Environment variables (process.env)
 * @returns Fully configured RuntimeContext for the target platform
 */
export function createRuntime(env: Record<string, unknown>): RuntimeContext {
  const mode = (env.HEOPRESS_RUNTIME as string | undefined)?.trim() || 'docker';
  if (mode !== 'docker') {
    // The Cloudflare Workers runtime was removed in HeoPress P02 (ADR-0002).
    throw new Error(`HEOPRESS_RUNTIME="${mode}" is not supported; HeoPress runs only on Node.js (docker).`);
  }
  return createDockerRuntime(env);
}
