// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import i18n from 'i18next';
import { getApiClient } from './api';
import { formatSafeError } from '@heopress/contracts/utils';
import { initStudioI18n } from '@/i18n';

/**
 * Initializes i18next for the Studio UI.
 * Loads the bundled Studio namespaces (`src/i18n`), then the 'ui' namespace
 * translations from the backend API.
 */
export async function initI18n() {
  if (i18n.isInitialized) return;

  const client = getApiClient();

  // Bundled Studio namespaces and the language choice (p07a task 1.3).
  await initStudioI18n(i18n);

  try {
    // Fetch supported locales from settings, or default to just 'en' for now
    const uiTranslations = await client.translations.list({ namespace: 'ui' });
    
    // Group by language
    const byLang: Record<string, Record<string, string>> = {};
    for (const t of uiTranslations.data) {
      if (!byLang[t.language]) byLang[t.language] = {};
      byLang[t.language]![t.key] = t.value;
    }

    // Add to i18next instance
    for (const [lang, keys] of Object.entries(byLang)) {
      i18n.addResourceBundle(lang, 'ui', keys, true, true);
    }
  } catch (error) {
    console.error('[i18n] Failed to load UI translations', formatSafeError(error));
  }
}
