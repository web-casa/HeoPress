import { useTranslation } from 'react-i18next';

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** `3 hours ago` in the interface language; under a minute counts as now. */
export function formatRelative(date: Date, now: Date, locale: string): string {
  const diff = date.getTime() - now.getTime();
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return format.format(0, 'second');
}

function formatExact(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** A relative time whose exact time shows on hover and to assistive tech (ADR-0019 §5.6). */
export function RelativeTime({ value, now }: { value: string | Date; now?: Date }) {
  const { i18n } = useTranslation();
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const exact = formatExact(date, i18n.language);
  return (
    <time dateTime={date.toISOString()} title={exact} aria-label={exact} className="t-num">
      {formatRelative(date, now ?? new Date(), i18n.language)}
    </time>
  );
}
