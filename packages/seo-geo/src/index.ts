/**
 * @heopress/seo-geo (HeoPress P07; Apache-2.0): the SEO / GEO data layer. Pure functions over a site's SEO
 * settings and a page's public data — no database, no HTTP — shared by the CMS (which decides the indexing of
 * translation-group members across sites for the language switch, and validates settings) and the rendering
 * services (which decide each page's indexing and serialise the head and the discovery outputs).
 */
export { decideIndexing, pageTypeOfCollection, parseItemRobots, robotsDirectives, TAXONOMY_COLLECTIONS, type IndexingInput, type IndexingResult, type ItemRobots, type SeoPageType } from './indexing.ts';
export {
  absoluteUrl,
  applyTemplate,
  DEFAULT_DESCRIPTION_TEMPLATE,
  DEFAULT_TITLE_TEMPLATE,
  pageDescription,
  pageHead,
  pageTitle,
  type HeadInput,
  type HeadMeta,
  type PageHead,
} from './head.ts';
export { identityNode, jsonLdText, structuredData, structuredDataReport, type JsonLdGraph, type JsonLdNode, type StructuredDataInput, type StructuredDataPage } from './structured-data.ts';
export { normalizedBody, normalizedContent, type ContentParts, type ContentToken } from './content.ts';
export { feedEntry, llmsEntry, sitemapEntry, type DiscoveryPage, type FeedEntry, type LlmsEntry, type SitemapEntry } from './entries.ts';
export {
  appliesTo,
  contributionFragment,
  itemStructuredData,
  LIMITS as STRUCTURED_DATA_LIMITS,
  materializeContribution,
  materializedNodes,
  STRUCTURED_DATA_CAPABILITY,
  validContributions,
  type MaterializedNode,
  type StructuredDataContribution,
  type StructuredDataDiagnostic,
} from './contributions.ts';
export { CRAWLERS, crawlerAllowed, crawlersOf, customCrawlerError, robotsTxt, type Crawler, type CrawlerPurpose, type RobotsInput } from './crawlers.ts';
export { AI_REFERRERS, aiReferrerOf, classifyVisit, crawlerOfUserAgent, type AiReferrer, type Visit } from './ai-traffic.ts';
export {
  crawlerTrafficHints,
  evaluateCrawler,
  evaluateProbe,
  expectedProbes,
  PLATFORMS as REACHABILITY_PLATFORM_INFO,
  REACHABILITY_PLATFORMS,
  reachabilityAdvice,
  robotsAllowsRoot,
  saysNoindex,
  SIMULATED_CRAWLERS,
  SIMULATION_NOTE,
  simulatedUserAgent,
  type CrawlerDay,
  type CrawlerVerdict,
  type ProbeKind,
  type ProbeObservation,
  type ProbeVerdict,
  type ReachabilityCode,
  type ReachabilityPlatform,
  type ReachabilityProbe,
  type ReachabilitySeverity,
  type SampledPage,
  type TrafficHint,
} from './reachability.ts';
