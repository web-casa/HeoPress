// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it, vi } from "vitest";

import { createHeoPressClient, HeoPressError } from "../client";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ok = (data: unknown) => jsonResponse(200, { data });
const unauthorized = () => jsonResponse(401, { errors: [{ code: "UNAUTHENTICATED", message: "nope" }] });
const refreshed = (n: number) =>
  jsonResponse(200, {
    data: { token: `access_${n}`, refreshToken: `refresh_${n}`, refreshTokenExpiresAt: "2030-01-01T00:00:00Z" },
  });

describe("createHeoPressClient auto-refresh", () => {
  it("refreshes on 401, retries once, and surfaces the rotated pair", async () => {
    const onTokensRefreshed = vi.fn();
    const calls: Array<{ path: string; auth: string | null }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ path, auth });
      if (path === "/api/v1/auth/refresh") return refreshed(2);
      // First data request (stale token) 401s; the retry (new token) succeeds.
      return auth === "Bearer access_2" ? ok({ ok: true }) : unauthorized();
    });

    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "access_1",
      refreshToken: "refresh_1",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      onTokensRefreshed,
    });

    const res = await client.rawRequest<{ ok: boolean }>("/api/v1/collections");
    expect(res.data.ok).toBe(true);

    // request(401) → refresh → request(retry) = 3 fetches.
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/collections",
      "/api/v1/auth/refresh",
      "/api/v1/collections",
    ]);
    expect(onTokensRefreshed).toHaveBeenCalledWith({
      token: "access_2",
      refreshToken: "refresh_2",
      refreshTokenExpiresAt: "2030-01-01T00:00:00Z",
    });
    // The client adopts the rotated access token for subsequent calls.
    expect(client.token).toBe("access_2");
  });

  it("falls back to onUnauthorized when refresh itself fails", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/auth/refresh") return unauthorized();
      return unauthorized();
    });

    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "access_1",
      refreshToken: "refresh_1",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(HeoPressError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not retry when no refresh token is configured (legacy behaviour)", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () => unauthorized());
    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "stale",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(HeoPressError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("coalesces parallel 401s into a single refresh", async () => {
    let refreshCount = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const auth = new Headers(init?.headers).get("authorization");
      if (path === "/api/v1/auth/refresh") {
        refreshCount += 1;
        return refreshed(2);
      }
      return auth === "Bearer access_2" ? ok({ ok: true }) : unauthorized();
    });

    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "access_1",
      refreshToken: "refresh_1",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await Promise.all([
      client.rawRequest("/api/v1/a"),
      client.rawRequest("/api/v1/b"),
      client.rawRequest("/api/v1/c"),
    ]);
    expect(refreshCount).toBe(1);
  });
});

describe("createHeoPressClient with a host-owned session (P04)", () => {
  it("reads the token for every request and renews through the host, never its own refresh call", async () => {
    let current = "access_1";
    const refresh = vi.fn(async () => {
      current = "access_2";
      return current;
    });
    const seen: Array<{ path: string; auth: string | null }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ path, auth });
      return auth === "Bearer access_2" ? ok({ ok: true }) : unauthorized();
    });
    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "ignored",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      getToken: () => current,
      refresh,
    });
    await expect(client.rawRequest("/api/v1/items/posts")).resolves.toEqual({ data: { ok: true } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen.map((c) => c.path)).not.toContain("/api/v1/auth/refresh");
    expect(seen.map((c) => c.auth)).toEqual(["Bearer access_1", "Bearer access_2"]);
  });

  it("a host renewal that fails leaves the 401", async () => {
    const onUnauthorized = vi.fn();
    const client = createHeoPressClient({
      url: "https://api.example.test",
      token: "access_1",
      siteId: "site_1",
      fetcher: (async () => unauthorized()) as unknown as typeof fetch,
      refresh: async () => null,
      onUnauthorized,
    });
    await expect(client.rawRequest("/api/v1/items/posts")).rejects.toBeInstanceOf(HeoPressError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("RealtimeClient ticket", () => {
  it("requests the ticket through the host's fetcher when given one", async () => {
    const { RealtimeClient } = await import("../realtime/index");
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    const rt = new RealtimeClient({ baseUrl: "https://api.example.test", token: "t", siteId: "s", fetcher: fetcher as unknown as typeof fetch, initialBackoffMs: 60_000 });
    rt.connect();
    await new Promise((r) => setTimeout(r, 0));
    rt.disconnect();
    expect(fetcher).toHaveBeenCalledWith("https://api.example.test/api/v1/realtime/ticket", expect.objectContaining({ method: "POST" }));
  });
});
