/**
 * The theme contract (HeoPress P06 task 2.1; design §2, R2, R16, R28; ADR-0008: Apache-2.0, so themes
 * written against it may use any licence): the page data a template receives — the View Model — and its
 * JSON Schema. A template sees nothing else: no database rows, request, environment or secrets.
 *
 * Markup is never data: the item body, the SEO head (with the page's one JSON-LD graph, HeoPress P07) and sponsor
 * disclosures come only from the system tags (`{% item_body %}`, `{% seo_head %}`, `{% sponsor_disclosure item %}`,
 * `{% card item %}…{% endcard %}`), filled in by the renderer after the template ran. A theme writes no JSON-LD.
 *
 * Self-contained on purpose (no relative imports): the rendering worker loads it directly.
 */

export const THEME_PAGE_TYPES = ['home', 'item', 'taxonomy', 'search', 'error'] as const;
export type ThemePageType = (typeof THEME_PAGE_TYPES)[number];

/** A field value as the public may see it (public fields only, rich text excluded: that is `item_body`). */
export type ThemeFieldValue = string | number | boolean | null | ThemeFieldValue[] | { [key: string]: ThemeFieldValue };

export interface ThemeSponsor {
  sponsored: boolean;
  /** The sponsor's name, when the item is sponsored and names one. */
  name: string | null;
}

export interface ThemeItem {
  id: string;
  collection: string;
  title: string;
  url: string;
  locale: string;
  /** ISO 8601, or null for an item without a first publication time. */
  publishedAt: string | null;
  /** Public, non-rich fields of the item. */
  fields: Record<string, ThemeFieldValue>;
  sponsor: ThemeSponsor;
}

export interface ThemeCard {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string | null;
  sponsored: boolean;
}

export interface ThemeLink {
  label: string;
  url: string;
}

export interface ThemeViewModel {
  site: { name: string; locale: string; locales: string[]; homeUrl: string };
  page: { type: ThemePageType; locale: string; path: string; status: number; query: string | null };
  item: ThemeItem | null;
  list: ThemeCard[];
  pagination: { page: number; prevUrl: string | null; nextUrl: string | null } | null;
  alternates: Array<{ locale: string; url: string }>;
  nav: ThemeLink[];
  /** The data `{% seo_head %}` renders (the theme cannot change the head it produces). */
  seo: { title: string; description: string; canonical: string | null; robots: string | null };
}

/** Top-level names a template may read (anything else is refused before publication). */
export const THEME_ROOTS = ['site', 'page', 'item', 'list', 'pagination', 'alternates', 'nav', 'seo'] as const;

const str = { type: 'string' } as const;
const nullableStr = { type: ['string', 'null'] } as const;
const link = { type: 'object', additionalProperties: false, required: ['label', 'url'], properties: { label: str, url: str } } as const;

/** JSON Schema (draft 2020-12) of `ThemeViewModel`: the renderer validates every View Model before rendering. */
export const THEME_VIEW_MODEL_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.example.com/heopress/theme-view-model.json',
  type: 'object',
  additionalProperties: false,
  required: ['site', 'page', 'item', 'list', 'pagination', 'alternates', 'nav', 'seo'],
  properties: {
    site: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'locale', 'locales', 'homeUrl'],
      properties: { name: str, locale: str, locales: { type: 'array', items: str }, homeUrl: str },
    },
    page: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'locale', 'path', 'status', 'query'],
      properties: {
        type: { enum: [...THEME_PAGE_TYPES] },
        locale: str,
        path: str,
        status: { type: 'integer', minimum: 100, maximum: 599 },
        query: nullableStr,
      },
    },
    item: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'collection', 'title', 'url', 'locale', 'publishedAt', 'fields', 'sponsor'],
          properties: {
            id: str,
            collection: str,
            title: str,
            url: str,
            locale: str,
            publishedAt: nullableStr,
            fields: { type: 'object' },
            sponsor: {
              type: 'object',
              additionalProperties: false,
              required: ['sponsored', 'name'],
              properties: { sponsored: { type: 'boolean' }, name: nullableStr },
            },
          },
        },
      ],
    },
    list: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'excerpt', 'url', 'publishedAt', 'sponsored'],
        properties: { id: str, title: str, excerpt: str, url: str, publishedAt: nullableStr, sponsored: { type: 'boolean' } },
      },
    },
    pagination: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['page', 'prevUrl', 'nextUrl'],
          properties: { page: { type: 'integer', minimum: 1 }, prevUrl: nullableStr, nextUrl: nullableStr },
        },
      ],
    },
    alternates: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['locale', 'url'], properties: { locale: str, url: str } },
    },
    nav: { type: 'array', items: link },
    seo: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'description', 'canonical', 'robots'],
      properties: { title: str, description: str, canonical: nullableStr, robots: nullableStr },
    },
  },
} as const;
