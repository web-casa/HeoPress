import { describe, expect, it, vi } from "vitest";

import { createHeoPressClient } from "../client";
import { legacyRest } from "../rest";

/**
 * Site identity SDK methods (HeoPress P07 task 2.12): `site.identity()` reads `GET /api/v1/site/identity`,
 * `site.updateIdentity()` sends the form as JSON with `PUT`. The transport is a captured fetcher; no server.
 */
function harness(responseBody: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createHeoPressClient({ url: "https://api.example.test", token: "t", siteId: "site_1", fetcher: fetcher as unknown as typeof fetch }).with(legacyRest());
  return { client, calls };
}

describe("site identity SDK methods", () => {
  it("reads the identity", async () => {
    const { client, calls } = harness({ data: { identity: null, version: 0 } });
    const res = await client.site.identity();
    expect(calls[0]!.method).toBe("GET");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/site/identity");
    expect(res.data).toEqual({ identity: null, version: 0 });
  });

  it("updates it with PUT and the form as the JSON body", async () => {
    const input = { version: 0, kind: "person" as const, name: "Sam", sameAs: ["https://social.example.com/sam"] };
    const { client, calls } = harness({ data: { identity: input, version: 1 } });
    await client.site.updateIdentity(input);
    expect(calls[0]!.method).toBe("PUT");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/site/identity");
    expect(calls[0]!.body).toEqual(input);
  });
});
