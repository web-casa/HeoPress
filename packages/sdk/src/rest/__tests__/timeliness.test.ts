import { describe, expect, it } from "vitest";

import { createHeoPressClient } from "../../client";
import { legacyRest } from "../legacy";

/**
 * Timeliness marks in the SDK (HeoPress v1.1; spec content/timeliness-marks): the list filter travels as
 * `needs_update=true`, and the mark/clear endpoints are versioned item writes (the clear names the version as
 * `If-Match`, as `delete` does).
 */

function recording(response: () => Response) {
  const requests: Array<{ url: string; method: string; body: unknown; ifMatch: string | null }> = [];
  const client = createHeoPressClient({
    url: "https://api.example.test",
    token: "t",
    siteId: "site_1",
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: new Headers(init?.headers).get("if-match"),
      });
      return response();
    },
  }).with(legacyRest());
  return { client, requests };
}

const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const mark = {
  itemId: "item_1",
  needsUpdateSince: "2026-11-10T00:00:00.000Z",
  reason: "Prices changed",
  dueAt: null,
  version: 2,
};

describe("SDK timeliness marks", () => {
  it("asks the list for marked items only, and leaves the filter out otherwise", async () => {
    const { client, requests } = recording(() => json([]));
    await client.items("articles" as never).list({ needsUpdate: true });
    expect(requests[0]!.url).toContain("/api/v1/items/articles?needs_update=true");

    await client.items("articles" as never).list({ needsUpdate: false });
    expect(requests[1]!.url).not.toContain("needs_update");
  });

  it("marks with the reason, the deadline and the expected version", async () => {
    const { client, requests } = recording(() => json(mark));
    const res = await client.items("articles" as never).markTimeliness("item_1", {
      reason: "Prices changed",
      dueAt: "2026-12-01T00:00:00.000Z",
      expectedVersion: 1,
    });
    expect(res.data.version).toBe(2);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toContain("/api/v1/items/articles/item_1/timeliness");
    expect(requests[0]!.body).toEqual({
      reason: "Prices changed",
      dueAt: "2026-12-01T00:00:00.000Z",
      expectedVersion: 1,
    });
  });

  it("clears the mark with If-Match", async () => {
    const { client, requests } = recording(() => json({ ...mark, needsUpdateSince: null, version: 3 }));
    await client.items("articles" as never).clearTimeliness("item_1", { expectedVersion: 2 });
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url).toContain("/api/v1/items/articles/item_1/timeliness");
    expect(requests[0]!.ifMatch).toBe('"2"');
  });
});
