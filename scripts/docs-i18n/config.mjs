// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// Configuration for the docs i18n sync tooling.
// Central place for paths, locales and machine-translation engine settings.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (scripts/docs-i18n -> repo root). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Root folder that holds the per-locale docs trees. Override with DOCS_ROOT env. */
export const DOCS_ROOT = process.env.DOCS_ROOT
  ? path.resolve(process.env.DOCS_ROOT)
  : path.join(REPO_ROOT, 'docs');

/**
 * Supported locales (HeoPress P02: zh-CN and en replace the upstream en/vi
 * pair). `DEFAULT_LOCALE` is the language maintained docs are written in;
 * English docs carried over from upstream are kept as reference until they
 * get a Chinese source.
 */
export const LOCALES = ['zh-CN', 'en'];
export const DEFAULT_LOCALE = 'zh-CN';

/** The "other" locale for a given one (only valid for a 2-locale setup). */
export function otherLocale(locale) {
  return locale === 'en' ? 'zh-CN' : 'en';
}

/** Folders inside docs/<locale> that should never be treated as doc pages. */
export const IGNORED_DIRS = new Set(['node_modules', 'dist', '.i18n']);

/** Files (relative to docs/<locale>) that are managed manually, never auto-synced. */
export const IGNORED_FILES = new Set([
  // sync log lives outside the locale trees, listed for safety
  'i18n-sync-log.md',
]);

/** Where the append-only sync log is written (relative to DOCS_ROOT). */
export const SYNC_LOG_PATH = path.join(DOCS_ROOT, 'i18n-sync-log.md');

/** Where the machine-readable sync report is written (relative to DOCS_ROOT). */
export const SYNC_REPORT_PATH = path.join(DOCS_ROOT, '.i18n', 'last-report.json');

/**
 * Translation engine configuration.
 *
 * Translation is performed by Claude (Anthropic Messages API) — no third-party
 * machine-translation services. Credentials are read from the environment so no
 * secret lives in the repo.
 *
 *   ANTHROPIC_API_KEY  = <key>                  (required for actual translation)
 *   ANTHROPIC_MODEL    = <model id>             (default: claude-sonnet-4-6)
 *   ANTHROPIC_BASE_URL = https://api.anthropic.com (override for proxies)
 *   ANTHROPIC_MAX_TOKENS = <int>                (default: 8192 per request)
 */
export function getEngineConfig(env = process.env) {
  return {
    engine: 'claude',
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    maxTokens: Number(env.ANTHROPIC_MAX_TOKENS || 8192),
  };
}

/** Full language names per locale, used in the translation instruction to Claude. */
export const LOCALE_NAMES = { 'zh-CN': 'Simplified Chinese', en: 'English' };
