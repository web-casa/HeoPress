import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

/**
 * Studio interface languages (ADR-0019 §6, p07a task 1.3): simplified
 * Chinese and English, one JSON file per module namespace under
 * `src/i18n/<lang>/`. `scripts/check-studio-i18n.mjs` keeps both languages'
 * keys identical.
 */
const STUDIO_LANGUAGES = ['zh-CN', 'en'] as const;
export type StudioLanguage = (typeof STUDIO_LANGUAGES)[number];

/** Each language's namespaces, a chunk of its own: only the language shown is loaded (p07a task 13.3). */
const BUNDLES: Record<StudioLanguage, () => Promise<{ default: Record<string, Record<string, unknown>> }>> = {
  'zh-CN': () => import('./bundles/zh-CN'),
  en: () => import('./bundles/en'),
};

/** `{ shell: {...}, overview: {...} }` of a language. */
export async function studioResources(lang: StudioLanguage): Promise<Record<string, Record<string, unknown>>> {
  return (await BUNDLES[lang]()).default;
}

/** Add a language's namespaces to i18next, once. */
async function ensureLanguage(lang: StudioLanguage, instance: typeof i18n): Promise<void> {
  if (instance.hasResourceBundle(lang, 'shell')) return;
  for (const [ns, keys] of Object.entries(await studioResources(lang))) instance.addResourceBundle(lang, ns, keys, true, true);
}

/**
 * The language to show: the user's saved choice, else the browser's
 * (any `zh*` → simplified Chinese), else English.
 */
export function pickLanguage(saved: string | null | undefined, browser: readonly string[]): StudioLanguage {
  if (saved === 'zh-CN' || saved === 'en') return saved;
  for (const tag of browser) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

const LOCAL_KEY = 'heopress.studio.language';

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function savedLocal(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCAL_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Add the picked language's namespaces to i18next and switch to it. */
export async function initStudioI18n(instance = i18n): Promise<void> {
  if (!instance.isInitialized) {
    await instance.use(initReactI18next).init({
      fallbackLng: 'en',
      lng: 'en',
      ns: ['ui'],
      defaultNS: 'ui',
      interpolation: { escapeValue: false },
      resources: {},
    });
  }
  const lang = pickLanguage(savedLocal(), browserLanguages());
  await ensureLanguage(lang, instance);
  await instance.changeLanguage(lang);
  document.documentElement.lang = instance.language;
}

/** Apply a saved choice (`null`: follow the browser). Kept locally too, for the sign-in page. */
export async function setStudioLanguage(saved: StudioLanguage | null | undefined, instance = i18n): Promise<void> {
  try {
    if (saved) globalThis.localStorage?.setItem(LOCAL_KEY, saved);
    else globalThis.localStorage?.removeItem(LOCAL_KEY);
  } catch {
    // Blocked storage: the server copy still holds the choice.
  }
  const lang = pickLanguage(saved, browserLanguages());
  await ensureLanguage(lang, instance);
  if (instance.language !== lang) await instance.changeLanguage(lang);
  document.documentElement.lang = lang;
}
