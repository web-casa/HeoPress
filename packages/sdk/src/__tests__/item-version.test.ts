import { describe, expect, it } from "vitest";

import { createHeoPressClient, isVersionConflict, versionConflictOf } from "../client";
import { legacyRest } from "../rest/legacy";

/**
 * Item versions in the SDK (HeoPress P04 task 1.2): updates send the version
 * they are based on, and a 409 VERSION_CONFLICT is recognisable with the
 * current version and the changed fields.
 */

function recording(response: () => Response) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const client = createHeoPressClient({
    url: "https://api.example.test",
    token: "t",
    siteId: "site_1",
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response();
    },
  }).with(legacyRest());
  return { client, requests };
}

const ok = () =>
  new Response(JSON.stringify({ data: { id: "a", version: 13 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("SDK item versions", () => {
  it("patch, replace and revert send expectedVersion", async () => {
    const { client, requests } = recording(ok);
    const posts = client.items("posts" as never);
    await posts.patch("a", { data: { title: "x" }, expectedVersion: 12 });
    await posts.replace("a", { data: { title: "y" }, expectedVersion: 13 });
    await posts.revertRevision("a", "rev_1", 14);
    await posts.patchBlock("a", "body", "b_1", "<p>x</p>", 15);
    expect(requests.map((r) => [r.method, r.body])).toEqual([
      ["PATCH", { data: { title: "x" }, expectedVersion: 12 }],
      ["PUT", { data: { title: "y" }, expectedVersion: 13 }],
      ["POST", { expectedVersion: 14 }],
      ["PATCH", { block: "<p>x</p>", expectedVersion: 15 }],
    ]);
    expect(requests[3]!.url).toBe("https://api.example.test/api/v1/items/posts/a/blocks/body/b_1");
  });

  it("a 409 VERSION_CONFLICT is recognised with its details; other errors are not", async () => {
    const conflict = recording(
      () =>
        new Response(
          JSON.stringify({
            errors: [
              { code: "VERSION_CONFLICT", message: "changed", meta: { currentVersion: 13, changedFields: ["title"] } },
            ],
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const err = await conflict.client
      .items("posts" as never)
      .patch("a", { data: { title: "x" }, expectedVersion: 12 })
      .catch((e: unknown) => e);
    expect(isVersionConflict(err)).toBe(true);
    expect(versionConflictOf(err)).toEqual({ currentVersion: 13, changedFields: ["title"] });

    const other = recording(
      () =>
        new Response(JSON.stringify({ errors: [{ code: "DEPENDENT_RECORDS_EXIST", message: "x" }] }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const notConflict = await other.client.items("posts" as never).delete("a").catch((e: unknown) => e);
    expect(isVersionConflict(notConflict)).toBe(false);
    expect(versionConflictOf(new Error("x"))).toBeNull();
  });
});
