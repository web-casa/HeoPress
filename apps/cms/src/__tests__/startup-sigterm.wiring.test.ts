import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SIGTERM while the server starts (HeoPress P13 task 6.2).
 *
 * In the image the server is PID 1 (the entrypoint execs it), and the kernel drops a signal PID 1 has no handler
 * for. The graceful handler is installed only after every job is registered, so a container stopped during
 * startup used to ignore `docker stop` and be killed after the grace period (exit 137; seen by the image runtime
 * acceptance, docker/scripts/accept-image-runtime.sh). `serve.ts` now installs a startup handler at module load and
 * swaps it for the graceful one.
 *
 * Evidence class: source scan of the real file; the acceptance stops a worker right after it starts.
 */

const serve = readFileSync(join(__dirname, '..', 'serve.ts'), 'utf8');

describe('serve.ts handles SIGTERM during startup', () => {
  it('installs the startup handler at module level, before main() runs', () => {
    const install = serve.indexOf("process.on('SIGTERM', exitDuringStartup);");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(serve.indexOf('async function main() {'));
    expect(serve).toMatch(/function exitDuringStartup\(\): void \{[\s\S]*?process\.exit\(0\);/);
  });

  it('removes it right before installing the graceful handler', () => {
    const remove = serve.indexOf("process.off('SIGTERM', exitDuringStartup);");
    const graceful = serve.indexOf("process.on('SIGTERM', () => {");
    expect(remove).toBeGreaterThan(-1);
    expect(graceful).toBeGreaterThan(remove);
    expect(serve.slice(remove, graceful)).not.toMatch(/await /);
  });
});
