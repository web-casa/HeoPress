// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// Lightweight, offline Chinese-vs-English language detector for markdown docs.
//
// NOTE: This is a heuristic, not a statistical language model. It is tuned for the
// zh-CN/en pair only (HeoPress P02 replaced the upstream vi/en pair) and is
// deliberately conservative. Callers should treat a low `confidence` as
// "uncertain" rather than authoritative.

/** CJK Unified Ideographs (incl. extension A) and CJK punctuation. */
const CJK = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/u;

/**
 * Remove markdown constructs that are language-neutral (code, URLs, html) so the
 * detector only weighs prose.
 */
export function stripNonProse(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML front matter
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/\]\([^)]*\)/g, '] ') // link/image targets, keep link text
    .replace(/https?:\/\/\S+/g, ' ') // bare URLs
    .replace(/<[^>]+>/g, ' '); // html tags
}

/**
 * Detect whether a markdown string is primarily Simplified Chinese or English.
 *
 * Chinese prose routinely embeds English identifiers and product names, so the
 * decision is the share of CJK characters among all letters: above 20% reads as
 * Chinese (a Chinese page is typically 60–90%; an English page with a few CJK
 * names stays well under 5%).
 *
 * @returns {{ lang: 'zh-CN'|'en'|'unknown', confidence: number, cjkRatio: number, sampled: number }}
 */
export function detectLang(markdown) {
  const prose = stripNonProse(markdown);

  let letters = 0;
  let cjk = 0;
  for (const ch of prose) {
    if (CJK.test(ch)) {
      if (/\p{L}/u.test(ch)) {
        cjk += 1;
        letters += 1;
      }
    } else if (/\p{L}/u.test(ch)) {
      letters += 1;
    }
  }
  const words = prose.match(/[A-Za-z]+/g) || [];
  const cjkRatio = letters > 0 ? cjk / letters : 0;

  let lang;
  let confidence;
  if (letters === 0) {
    lang = 'unknown';
    confidence = 0;
  } else if (cjkRatio >= 0.2) {
    lang = 'zh-CN';
    confidence = Math.min(1, 0.3 + cjkRatio);
  } else {
    lang = 'en';
    confidence = Math.min(1, 0.5 + Math.min(words.length, 200) / 400) * (1 - cjkRatio);
  }

  return {
    lang,
    confidence: Number(confidence.toFixed(3)),
    cjkRatio: Number(cjkRatio.toFixed(4)),
    sampled: cjk + words.length,
  };
}
