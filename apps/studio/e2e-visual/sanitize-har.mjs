// Make a recorded `api.har` safe to commit (HeoPress P07a task 13.1): no credentials, cookies or signed tokens.
// Session tokens become unsigned stand-ins with the same claims (Studio only reads them; nothing verifies them in the
// replay), written so they do not look like JWTs to secret scanners. Run after recording:
//
//   node apps/studio/e2e-visual/sanitize-har.mjs apps/studio/e2e-visual/api.har
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: sanitize-har.mjs <file.har>');
const har = JSON.parse(readFileSync(file, 'utf8'));
const DROP = new Set(['authorization', 'cookie', 'set-cookie', 'x-heopress-refresh']);
const JWT = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const b64 = (s) => Buffer.from(s).toString('base64url');
const standIn = (jwt) => {
  const payload = Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8');
  // A leading space: still JSON, but the encoding no longer starts with "eyJ".
  return `${b64(' {"alg":"none"}')}.${b64(` ${payload}`)}.fixture`;
};
const clean = (text) =>
  typeof text === 'string'
    ? text.replace(JWT, standIn).replace(/"(refreshToken|refresh_token)":"[^"]*"/g, '"$1":"fixture-refresh-token"')
    : text;

for (const entry of har.log.entries) {
  for (const side of [entry.request, entry.response]) {
    side.headers = side.headers.filter((h) => !DROP.has(h.name.toLowerCase())).map((h) => ({ ...h, value: clean(h.value) }));
    if (side.cookies) side.cookies = [];
  }
  // A token in the address (the realtime connection): the same stand-in the replayed login hands out, so it still matches.
  entry.request.url = clean(entry.request.url);
  entry.request.queryString = (entry.request.queryString ?? []).map((q) => ({ ...q, value: clean(q.value) }));
  if (entry.request.postData?.text) entry.request.postData.text = clean(entry.request.postData.text);
  const content = entry.response.content;
  if (content?.text) {
    if (content.encoding === 'base64') {
      content.text = Buffer.from(clean(Buffer.from(content.text, 'base64').toString('utf8'))).toString('base64');
    } else content.text = clean(content.text);
  }
}
const out = JSON.stringify(har, null, 1);
if (new RegExp(JWT.source).test(out)) throw new Error('a token is left');
writeFileSync(file, `${out}\n`);
