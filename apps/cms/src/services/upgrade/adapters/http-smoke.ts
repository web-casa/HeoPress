/**
 * Read-only smoke test after an upgrade (HeoPress P13 task 2.1): the CMS is ready (`/health/ready` 200), reports the
 * target version, and every extra URL (public pages of the sites, e.g. `https://www.example.com/`) answers 200. Only
 * GET requests: writes are still frozen while it runs.
 */
import type { SmokePort } from '../ports';

export interface HttpSmokeOptions {
  /** CMS base URL, e.g. `http://127.0.0.1:1989`. */
  cmsUrl: string;
  /** Further pages that must answer 200. */
  urls?: string[];
  fetch?: typeof fetch;
  /** How long the CMS may take to become ready after the switch (default 120 s). */
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpSmoke implements SmokePort {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpSmokeOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  private async status(url: string): Promise<number | string> {
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      await res.body?.cancel().catch(() => {});
      return res.status;
    } catch (err) {
      return err instanceof Error ? err.name : 'error';
    }
  }

  async run(expectedVersion: string): Promise<{ ok: boolean; failures: string[] }> {
    const base = this.options.cmsUrl.replace(/\/+$/, '');
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 120_000);
    let ready = await this.status(`${base}/health/ready`);
    while (ready !== 200 && Date.now() < deadline) {
      await sleep(2000);
      ready = await this.status(`${base}/health/ready`);
    }
    const failures: string[] = [];
    if (ready !== 200) failures.push(`/health/ready answered ${ready}`);
    try {
      const res = await this.fetchFn(`${base}/api/v1/system/version`, { signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { version?: unknown };
      if (body.version !== expectedVersion) failures.push(`CMS reports version ${String(body.version)}, expected ${expectedVersion}`);
    } catch (err) {
      failures.push(`/api/v1/system/version: ${err instanceof Error ? err.name : 'error'}`);
    }
    for (const url of this.options.urls ?? []) {
      const s = await this.status(url);
      if (s !== 200) failures.push(`${url} answered ${s}`);
    }
    return { ok: failures.length === 0, failures };
  }
}
