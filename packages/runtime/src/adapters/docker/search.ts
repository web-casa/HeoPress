// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// meilisearch >=0.50 renamed the client class to `Meilisearch` (lowercase `s`)
// and dropped the old `MeiliSearch` named/default export. Alias it back so the
// provider naming below stays stable.
import { MeilisearchApiError, Meilisearch as MeiliSearch } from 'meilisearch';
import type {
  SearchProvider,
  SearchResult,
  SearchOptions,
  SearchIndexSettings,
} from '../../interfaces';
import { outboundFetch, serviceEndpointPolicy, trustedEndpointsFromEnv, type TrustedEndpoints } from '../../outbound/fetch';

/**
 * Optional MeiliSearch backend (HeoPress P03 task 5.2): used only when
 * MEILISEARCH_HOST is set; PostgreSQL full-text search is the default. The
 * host is a service connection under the outbound boundary — a private host
 * (compose's `http://meilisearch:7700`) must be a trusted internal endpoint.
 * Every SDK request goes through `outboundFetch` (Codex review 4, #1): each
 * address is checked at connect time, a redirect to another origin is
 * refused, and the response size and request time are capped.
 */
export class MeiliSearchProvider implements SearchProvider {
  private client: MeiliSearch;

  constructor(host: string, apiKey?: string, trusted?: TrustedEndpoints) {
    const trustedEndpoints = trusted ?? trustedEndpointsFromEnv();
    serviceEndpointPolicy(host, trustedEndpoints); // refuse a bad host at startup
    this.client = new MeiliSearch({
      host,
      apiKey,
      httpClient: async (input, init) => {
        const res = await outboundFetch(String(input instanceof Request ? input.url : input), {
          ...init,
          purpose: 'service',
          trusted: trustedEndpoints,
          timeoutMs: 60_000,
          maxResponseBytes: 50 * 1024 * 1024,
        });
        const text = await res.text();
        const body = text === '' ? undefined : JSON.parse(text);
        if (!res.ok) throw new MeilisearchApiError(res, body);
        return body;
      },
    });
  }

  async index(collection: string, documents: Record<string, unknown>[]): Promise<void> {
    const index = this.client.index(collection);
    await index.addDocuments(documents);
  }

  async search<T>(collection: string, query: string, options?: SearchOptions): Promise<SearchResult<T>> {
    const index = this.client.index(collection);
    let result;
    try {
      result = await index.search(query, {
        filter: options?.filter,
        sort: options?.sort,
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
        attributesToRetrieve: options?.attributesToRetrieve,
      });
    } catch (err) {
      // Search sync creates a collection's index with its first document
      // (an event consumer since HeoPress P04): until then there is nothing
      // to find, which is not an error.
      if (isIndexNotFound(err)) return { hits: [], totalHits: 0, processingTimeMs: 0 };
      throw err;
    }
    return {
      hits: result.hits as T[],
      totalHits: result.estimatedTotalHits ?? 0,
      processingTimeMs: result.processingTimeMs,
    };
  }

  async delete(collection: string, documentIds: string[]): Promise<void> {
    const index = this.client.index(collection);
    await index.deleteDocuments(documentIds);
  }

  async getIndex(collection: string): Promise<{ numberOfDocuments: number }> {
    try {
      const stats = await this.client.index(collection).getStats();
      return { numberOfDocuments: stats.numberOfDocuments };
    } catch (err) {
      if (isIndexNotFound(err)) return { numberOfDocuments: 0 };
      throw err;
    }
  }

  async configureIndex(collection: string, settings: SearchIndexSettings): Promise<void> {
    const index = this.client.index(collection);
    await index.updateSettings(settings);
  }
}

/** The SDK wraps the API error (MeilisearchRequestError → MeilisearchApiError → { code }). */
function isIndexNotFound(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof MeilisearchApiError && e.cause?.code === 'index_not_found') return true;
  }
  return false;
}
