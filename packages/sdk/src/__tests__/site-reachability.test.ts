import { describe, expect, it, vi } from "vitest";

import { createHeoPressClient } from "../client";
import { legacyRest } from "../rest";

/**
 * Reachability check SDK methods (HeoPress P07 task 3.9): the last report, and a check asked for with its hosts and
 * platform. The transport is a captured fetcher; no server.
 */
function harness(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  });
  const client = createHeoPressClient({ url: "https://api.example.test", token: "t", siteId: "site_1", fetcher: fetcher as unknown as typeof fetch }).with(legacyRest());
  return { client, calls };
}

describe("reachability SDK methods", () => {
  it("the report, and a run with its hosts and platform", async () => {
    const { client, calls } = harness({ data: { requested: true } }, 202);
    await client.site.reachability();
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/site/reachability");
    await client.site.runReachability({ hosts: ["www.example.com"], platform: "cloudflare" });
    expect(calls[1]).toMatchObject({ method: "POST", body: { hosts: ["www.example.com"], platform: "cloudflare" } });
    expect(new URL(calls[1]!.url).pathname).toBe("/api/v1/site/reachability/run");
  });
});
