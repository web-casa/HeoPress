import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setStudioLanguage } from '@/i18n';
import { hasActiveToken } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAppearance, type Density, type ThemeChoice } from '@/theme/appearance';
import { saveStudioPreferences } from '../shell/preferences';
import { PageHeader } from '../ui/page-header';

type LanguageChoice = 'zh-CN' | 'en' | 'browser';

/** Settings › Appearance (ADR-0019 §5.8, §6; p07a task 12.1): theme with a small preview, density, language. */
export function AppearancePage() {
  const { t, i18n } = useTranslation(['settings', 'shell', 'common']);
  const theme = useAppearance((s) => s.theme) ?? 'system';
  const density = useAppearance((s) => s.density);
  const [language, setLanguage] = useState<LanguageChoice>(() => {
    try {
      const saved = localStorage.getItem('heopress.studio.language');
      return saved === 'zh-CN' || saved === 'en' ? saved : 'browser';
    } catch {
      return 'browser';
    }
  });
  const [saved, setSaved] = useState(false);

  const persist = (patch: Parameters<typeof saveStudioPreferences>[0]) => {
    if (!hasActiveToken()) return;
    void saveStudioPreferences(patch).then(() => setSaved(true), () => setSaved(false));
  };

  const chooseTheme = (next: ThemeChoice) => {
    useAppearance.getState().set({ theme: next });
    persist({ theme: next });
  };
  const chooseDensity = (next: Density) => {
    useAppearance.getState().set({ density: next });
    persist({ density: next });
  };
  const chooseLanguage = (next: LanguageChoice) => {
    setLanguage(next);
    const value = next === 'browser' ? null : next;
    void setStudioLanguage(value, i18n);
    persist({ language: value });
  };

  return (
    <>
      <PageHeader title={t('appearance.title')} description={t('appearance.description')} />
      <div className="flex flex-col gap-6">
        <fieldset>
          <legend className="mb-2 t-section">{t('appearance.theme')}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {(['light', 'dark', 'system'] as const).map((choice) => (
              <label
                key={choice}
                className={cn(
                  'cursor-pointer rounded-card border p-3 transition-colors',
                  theme === choice ? 'border-brand bg-sel' : 'border-line bg-panel hover:bg-panel-2',
                )}
              >
                <input type="radio" name="theme" value={choice} checked={theme === choice} onChange={() => chooseTheme(choice)} className="sr-only" />
                <ThemeThumb choice={choice} />
                <span className="mt-2 block text-[13px] font-medium">{t(`shell:themes.${choice}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 t-section">{t('appearance.density')}</legend>
          <div className="inline-flex rounded-ctl bg-panel-2 p-0.5">
            {(['comfortable', 'compact'] as const).map((choice) => (
              <label key={choice} className={cn('cursor-pointer rounded-[6px] px-3 py-1.5 text-[13px]', density === choice ? 'bg-panel font-medium shadow-sm' : 'text-dim')}>
                <input type="radio" name="density" value={choice} checked={density === choice} onChange={() => chooseDensity(choice)} className="sr-only" />
                {t(`appearance.${choice}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="studio-language" className="mb-2 block t-section">{t('appearance.language')}</label>
          <select
            id="studio-language"
            value={language}
            onChange={(e) => chooseLanguage(e.target.value as LanguageChoice)}
            className="h-9 rounded-ctl border border-line bg-panel px-2 text-[13.5px]"
          >
            <option value="browser">{t('appearance.followBrowser')}</option>
            <option value="zh-CN">{t('common:languageNames.zhCN')}</option>
            <option value="en">{t('common:languageNames.en')}</option>
          </select>
        </div>
        <p className="t-aux">{t('appearance.motion')}</p>
        {saved ? <p role="status" className="t-aux">{t('appearance.saved')}</p> : null}
      </div>
    </>
  );
}

/** A small, fixed-colour preview of each theme (it must not follow the current theme). */
function ThemeThumb({ choice }: { choice: ThemeChoice }) {
  const half = (bg: string, line: string, accent: string) => (
    <span className="flex h-full flex-1 gap-1 p-1.5" style={{ background: bg }}>
      <span className="w-2 rounded-sm" style={{ background: line }} />
      <span className="flex flex-1 flex-col gap-1">
        <span className="h-1.5 w-2/3 rounded-sm" style={{ background: accent }} />
        <span className="h-1.5 w-full rounded-sm" style={{ background: line }} />
        <span className="h-1.5 w-4/5 rounded-sm" style={{ background: line }} />
      </span>
    </span>
  );
  const light = half('#F7F7F9', '#E4E4E9', '#5B57E0');
  const dark = half('#0D0D10', '#26262C', '#8A87FF');
  return (
    <span aria-hidden="true" className="flex h-16 overflow-hidden rounded-ctl border border-line">
      {choice === 'light' ? light : choice === 'dark' ? dark : (
        <>
          {light}
          {dark}
        </>
      )}
    </span>
  );
}
