// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { HeoPressClient, HeoPressError, type HeoPressErrorBody } from "../client";

/**
 * GraphQL composable plugin for the HeoPress SDK.
 *
 * Usage:
 * ```ts
 * const client = createHeoPressClient({ url, token, siteId }).with(graphql());
 * const { articles } = await client.query<{ articles: Article[] }>(
 *   `query ($limit: Int) { articles(limit: $limit) { id title } }`,
 *   { limit: 10 },
 * );
 * ```
 *
 * It reuses the core `rawRequest` (which already sets `Authorization` +
 * `X-HeoPress-Site`, parses the body, and fires `onUnauthorized` on 401) and
 * normalises GraphQL `errors[]` into the same `HeoPressError` thrown by the REST
 * layer, so error handling stays identical across both surfaces.
 */

interface GraphQLFormattedError {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLFormattedError[];
}

export interface GraphQLExtension {
  /** Executes a GraphQL document and returns the `data` payload. */
  query: <T = unknown>(document: string, variables?: Record<string, unknown>) => Promise<T>;
  /** Alias of `query` — semantic helper for mutations. */
  mutate: <T = unknown>(document: string, variables?: Record<string, unknown>) => Promise<T>;
}

export function graphql(endpoint = "/api/v1/graphql") {
  return (client: HeoPressClient): GraphQLExtension => {
    async function execute<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
      const res = await client.rawRequest<unknown>(endpoint, {
        method: "POST",
        body: JSON.stringify({ query: document, variables }),
      });
      // GraphQL Yoga answers with HTTP 200 + `{ data, errors }`, so the
      // raw body (not the REST `{ data, meta }` envelope) is what we get.
      const body = res as unknown as GraphQLResponse<T>;

      if (body.errors?.length) {
        const errorBody: HeoPressErrorBody = {
          errors: body.errors.map((e) => ({
            code: typeof e.extensions?.code === "string" ? e.extensions.code : "GRAPHQL_ERROR",
            message: e.message,
            path: e.path?.map(String),
            ...e.extensions,
          })),
        };
        const status = Number(body.errors[0]?.extensions?.status) || 400;
        throw new HeoPressError(status, errorBody);
      }

      if (body.data === undefined || body.data === null) {
        throw new HeoPressError(500, {
          errors: [{ code: "GRAPHQL_EMPTY", message: "GraphQL response contained no data." }],
        });
      }

      return body.data;
    }

    return {
      query: <T = unknown>(document: string, variables?: Record<string, unknown>) =>
        execute<T>(document, variables),
      mutate: <T = unknown>(document: string, variables?: Record<string, unknown>) =>
        execute<T>(document, variables),
    };
  };
}
