/**
 * The built-in minimal status page (HeoPress P06 task 4.1): what a request gets when the site's own error
 * page cannot be rendered (no theme, the theme failed too, the pool is saturated). Static, escaped, no
 * stack and no internal detail.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STATUS_TEXT: Record<number, string> = { 403: 'Forbidden', 404: 'Not found', 410: 'Gone', 503: 'Temporarily unavailable', 500: 'Error' };

export function statusPage(status: number, siteName: string | null, lang = 'en'): string {
  const text = STATUS_TEXT[status] ?? 'Error';
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(siteName ? `${text} · ${siteName}` : text)}</title>
</head>
<body>
<main>
<h1>${status}</h1>
<p>${escapeHtml(text)}</p>
</main>
</body>
</html>
`;
}
