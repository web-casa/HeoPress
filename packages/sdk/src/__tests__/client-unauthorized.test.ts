// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it, vi } from "vitest";

import { createHeoPressClient, HeoPressError } from "../client";

function errorResponse(status: number, code = "UNAUTHENTICATED") {
  return new Response(JSON.stringify({ errors: [{ code, message: "nope" }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHeoPressClient onUnauthorized", () => {
  it("fires onUnauthorized once and still throws HeoPressError on a 401", async () => {
    const onUnauthorized = vi.fn();
    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "stale",
      siteId: "site_1",
      fetcher: async () => errorResponse(401),
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(
      HeoPressError,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onUnauthorized on non-401 errors", async () => {
    const onUnauthorized = vi.fn();
    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "ok",
      siteId: "site_1",
      fetcher: async () => errorResponse(403, "FORBIDDEN"),
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(
      HeoPressError,
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("a throwing onUnauthorized handler does not mask the HeoPressError", async () => {
    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "stale",
      siteId: "site_1",
      fetcher: async () => errorResponse(401),
      onUnauthorized: () => {
        throw new Error("handler blew up");
      },
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toMatchObject({
      name: "HeoPressError",
      status: 401,
    });
  });
});
