// A stand-in OpenAI-compatible model service for the model settings scenario
// (HeoPress P04 task 7.6). Studio's probe goes through the real CMS, its
// outbound boundary and ledger to this server, listed in
// HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS by playwright.config.ts.
//
//   POST /ok/v1/chat/completions       answers the probe: calls the tool, returns JSON; reports usage
//   POST /limited/v1/chat/completions  429 without usage (billing unknown: to reconcile)
//   GET  /requests                     what was received: path and Authorization header
import { createServer } from 'node:http';

const port = Number(process.env.E2E_MODEL_PORT ?? 1993);
const received = [];

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/requests') return send(res, 200, received);
    received.push({ path: req.url, authorization: req.headers.authorization ?? null });
    if (req.url === '/limited/v1/chat/completions') return send(res, 429, { error: { message: 'rate limited' } });
    if (req.url !== '/ok/v1/chat/completions') return send(res, 404, { error: { message: 'not found' } });
    const body = raw ? JSON.parse(raw) : {};
    const usage = { prompt_tokens: 20, completion_tokens: 5 };
    if (body.tools) {
      return send(res, 200, {
        choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: body.tools[0].function.name, arguments: '{"ok":true}' } }] } }],
        usage,
      });
    }
    return send(res, 200, { choices: [{ message: { content: '{"ok": true}' } }], usage });
  });
}).listen(port, '127.0.0.1');
