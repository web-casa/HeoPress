import { cloudflareProvider } from './cloudflare';
import { crawl4aiProvider } from './crawl4ai';
import { firecrawlProvider } from './firecrawl';
import { tinyfishProvider } from './tinyfish';
import type { CrawlProvider, ProviderId } from './types';

/** The built-in crawl services (HeoPress P08 task 3.2). */
export const CRAWL_PROVIDERS: Readonly<Record<ProviderId, CrawlProvider>> = {
  tinyfish: tinyfishProvider,
  firecrawl: firecrawlProvider,
  crawl4ai: crawl4aiProvider,
  cloudflare: cloudflareProvider,
};
