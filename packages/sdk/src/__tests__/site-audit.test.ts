import { describe, expect, it, vi } from "vitest";

import { createHeoPressClient } from "../client";
import { legacyRest } from "../rest";

/**
 * Site audit SDK methods (HeoPress P07 tasks 5.1, 5.2): the issues, a run, and the export — which is the document itself,
 * not wrapped in `data` (its `version`, `siteId` and `issues` at the top). The transport is a captured fetcher; no server.
 */
function harness(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  });
  const client = createHeoPressClient({ url: "https://api.example.test", token: "t", siteId: "site_1", fetcher: fetcher as unknown as typeof fetch }).with(legacyRest());
  return { client, calls };
}

describe("site audit SDK methods", () => {
  it("the export is the document as the server sends it", async () => {
    const doc = { version: 1, siteId: "site_1", generatedAt: "2026-10-22T00:00:00Z", run: { lastRunAt: null, status: null, requested: false, truncated: false, error: null }, rules: [], total: 0, issues: [] };
    const { client, calls } = harness(doc);
    const res = await client.site.auditExport();
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/site/audit/export");
    expect(res).toEqual(doc);
    expect(res.version).toBe(1);
    expect(res.siteId).toBe("site_1");
  });

  it("the issues by rule, and a run with POST", async () => {
    const { client, calls } = harness({ data: { requested: true } }, 202);
    await client.site.audit("links/broken");
    expect(new URL(calls[0]!.url).search).toBe("?rule=links%2Fbroken");
    await client.site.runAudit();
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(new URL(calls[1]!.url).pathname).toBe("/api/v1/site/audit/run");
  });
});
