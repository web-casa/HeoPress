import type { CollectionInput, FieldInput } from '../schema-service';

/**
 * The site network preset (HeoPress P05 task 1.1, spec
 * content/site-network-model "站群预设集合"): the collections every site of a
 * network starts with — articles, pages, categories, tags, authors — and
 * their standard fields.
 *
 * Status, Hold and the publish times are item columns, not fields. A
 * translation group is a membership (`lumibase_translation_group_members`),
 * not a field. Categories, tags and authors keep their short multilingual
 * values (name, description) in a `translations` field, `{ <locale>: {...} }`
 * (design decision 1). Articles reference categories and tags as arrays of
 * item ids; the primary category and the author are many-to-one relations.
 *
 * Every collection and field the preset installs is marked with
 * `meta.preset` / `options.preset` = `{ name, version, key }`, so an upgrade
 * can tell the preset's own from what a site added. Changing this file means
 * a new `version` and an upgrade that only adds (`preset-installer.ts`).
 */

export const SITE_NETWORK_PRESET = { name: 'site-network', version: 4 } as const;

interface PresetField extends FieldInput {
  /** Stable key of the field within the preset (survives a rename by the site). */
  key: string;
}

export interface PresetCollection {
  key: string;
  collection: CollectionInput;
  fields: PresetField[];
  /** Many-to-one relations: field name → related preset collection key. */
  relations?: Record<string, string>;
}

const text = (name: string, label: string, extra: Partial<PresetField> = {}): PresetField => ({
  key: name,
  name,
  type: 'string',
  interface: 'input',
  label,
  ...extra,
});

/**
 * A page's own indexing setting (`@heopress/seo-geo` `parseItemRobots`): `index,follow`, the default, follows the
 * site, page type and collection defaults; `index` indexes the page whatever they say (version 2); the others
 * set what they name.
 */
function seoRobotsField(): PresetField {
  return {
    key: 'seo_robots',
    name: 'seo_robots',
    type: 'string',
    interface: 'select-dropdown',
    label: 'Indexing',
    group: 'seo',
    defaultValue: 'index,follow',
    options: { choices: ['index,follow', 'index', 'noindex,follow', 'index,nofollow', 'noindex,nofollow'] },
    note: 'index,follow: the site default. index: always indexed. noindex: never (search engines, feeds, llms.txt, sitemaps).',
  };
}

/**
 * Choices a later preset version added to a field an earlier one installed (HeoPress P07 task 2.8): an upgrade
 * appends them to the field when its choices are still exactly what the earlier version installed — a field the
 * site changed is left as it is and reported.
 */
export const PRESET_CHOICE_UPGRADES: Readonly<Record<string, { from: readonly string[]; add: readonly string[] }>> = {
  seo_robots: { from: ['index,follow', 'noindex,follow', 'index,nofollow', 'noindex,nofollow'], add: ['index'] },
};

/**
 * The explicit questions and answers of an article or page (HeoPress P07 task 2.4; spec seo/page-metadata
 * "结构化数据规则"): the only source of its FAQPage structured data — a heading ending in a question mark is not one.
 * A repeater: each row is a block with its own stable ID (`_blockId`, `block-ids.ts`). Version 3.
 */
function faqField(): PresetField {
  return {
    key: 'faq',
    name: 'faq',
    type: 'json',
    interface: 'repeater',
    label: 'Questions and answers',
    defaultValue: [],
    options: {
      fields: [
        { name: 'question', type: 'string', interface: 'input', label: 'Question' },
        { name: 'answer', type: 'text', interface: 'textarea', label: 'Answer' },
      ],
      labelTemplate: '{question}',
      addLabel: 'Add a question',
    },
    note: 'Questions this page answers, written out: the page\'s FAQ structured data comes from these only.',
  };
}

/**
 * The item's own structured data (HeoPress P07 task 2.9; spec seo/page-metadata "关联结构化数据图"): JSON-LD text — a
 * node such as an Event, or several — checked and merged into the page's one graph (`@heopress/seo-geo`
 * `itemStructuredData`); what is left out is reported. Not a public field: only the merged graph is output. Version 4.
 */
function structuredDataField(): PresetField {
  return {
    key: 'structured_data',
    name: 'structured_data',
    type: 'text',
    interface: 'code',
    label: 'Structured data (JSON-LD)',
    group: 'seo',
    options: { language: 'json' },
    note: 'Extra schema.org nodes for this page, e.g. {"@type": "Event", "@id": "#event", …}. The system adds the page, site and article nodes itself.',
  };
}

/** Standard fields of articles and pages. */
function contentFields(): PresetField[] {
  return [
    text('title', 'Title', { required: true }),
    text('slug', 'Slug', { interface: 'slug', required: true, indexed: true }),
    { key: 'excerpt', name: 'excerpt', type: 'text', interface: 'textarea', label: 'Excerpt' },
    { key: 'body', name: 'body', type: 'text', interface: 'wysiwyg', label: 'Body' },
    text('seo_title', 'SEO title', { group: 'seo' }),
    { key: 'seo_description', name: 'seo_description', type: 'text', interface: 'textarea', label: 'SEO description', group: 'seo' },
    text('seo_image', 'Social image', { interface: 'file', group: 'seo' }),
    seoRobotsField(),
    text('canonical_url', 'Canonical URL', { group: 'seo', note: 'Empty: the item\'s own URL. Never copied to a new translation.' }),
    text('source_url', 'Source URL', { group: 'source' }),
    text('source_license', 'Source license', { group: 'source' }),
    text('source_attribution', 'Source attribution', { group: 'source' }),
    text('locale', 'Language', { required: true, indexed: true }),
    { key: 'sponsored', name: 'sponsored', type: 'boolean', interface: 'toggle', label: 'Sponsored', defaultValue: false, group: 'sponsorship' },
    text('sponsor_name', 'Sponsor', { group: 'sponsorship' }),
    faqField(),
    structuredDataField(),
  ];
}

const taxonomyFields = (): PresetField[] => [
  text('name', 'Name', { required: true }),
  text('slug', 'Slug', { interface: 'slug', required: true, indexed: true }),
  { key: 'translations', name: 'translations', type: 'json', interface: 'translations', label: 'Translations', defaultValue: {} },
  // Version 2 (HeoPress P07 task 2.8): a term page can be indexed, or not, against its page type's default.
  seoRobotsField(),
];

export const SITE_NETWORK_COLLECTIONS: PresetCollection[] = [
  {
    key: 'articles',
    collection: { name: 'articles', label: 'Article', pluralLabel: 'Articles', icon: 'article', versioning: true },
    fields: [
      ...contentFields(),
      text('primary_category', 'Primary category', { interface: 'select-dropdown-m2o' }),
      { key: 'categories', name: 'categories', type: 'json', interface: 'tags', label: 'Categories', defaultValue: [], options: { itemsOf: 'categories' } },
      { key: 'tags', name: 'tags', type: 'json', interface: 'tags', label: 'Tags', defaultValue: [], options: { itemsOf: 'tags' } },
      text('author', 'Author', { interface: 'select-dropdown-m2o' }),
    ],
    relations: { primary_category: 'categories', author: 'authors' },
  },
  {
    key: 'pages',
    collection: { name: 'pages', label: 'Page', pluralLabel: 'Pages', icon: 'description', versioning: true },
    fields: contentFields(),
  },
  {
    key: 'categories',
    collection: { name: 'categories', label: 'Category', pluralLabel: 'Categories', icon: 'folder' },
    fields: [
      ...taxonomyFields(),
      { key: 'description', name: 'description', type: 'text', interface: 'textarea', label: 'Description' },
      text('parent', 'Parent category', { interface: 'select-dropdown-m2o' }),
    ],
    relations: { parent: 'categories' },
  },
  {
    key: 'tags',
    collection: { name: 'tags', label: 'Tag', pluralLabel: 'Tags', icon: 'sell' },
    fields: taxonomyFields(),
  },
  {
    key: 'authors',
    collection: { name: 'authors', label: 'Author', pluralLabel: 'Authors', icon: 'person' },
    fields: [
      text('name', 'Name', { required: true }),
      text('slug', 'Slug', { interface: 'slug', required: true, indexed: true }),
      { key: 'bio', name: 'bio', type: 'text', interface: 'textarea', label: 'Biography' },
      text('avatar', 'Avatar', { interface: 'file' }),
      text('user', 'User', { interface: 'user' }),
      { key: 'translations', name: 'translations', type: 'json', interface: 'translations', label: 'Translations', defaultValue: {} },
      seoRobotsField(),
    ],
  },
];

/** The marker an installed collection or field carries. */
export function presetMarker(key: string): { name: string; version: number; key: string } {
  return { name: SITE_NETWORK_PRESET.name, version: SITE_NETWORK_PRESET.version, key };
}
