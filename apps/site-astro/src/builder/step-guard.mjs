// The network guard of a build step (HeoPress P12 task 4.3), preloaded with `--import` before the step's own code.
//
// A step may connect to the hosts in HEOPRESS_BUILD_STEP_HOSTS (`host:port`: the CMS read-only page data interface and
// the package registry) and nowhere else. Every TCP / TLS connection, UDP send and name lookup to another host is refused:
// the step sees an error, a line naming the host goes to the build log, and the process exits with 97 whatever the step
// does with the error — so the build fails. The step runs under Node's permission model as well (no child processes,
// workers or addons), so these modules are its only way out.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

const REFUSED_EXIT = 97;
const allowed = new Set(
  String(process.env.HEOPRESS_BUILD_STEP_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const allowedNames = new Set([...allowed].map((h) => h.replace(/:\d+$/, '')));
let refused = null;

function refuse(target) {
  refused = refused ?? target;
  process.exitCode = REFUSED_EXIT;
  try {
    process.stderr.write(`[heopress-build-step] refused connection to ${target}\n`);
  } catch {
    /* the log is best effort; the exit code is not */
  }
  const err = new Error(`connection to ${target} refused: a build step may reach only the package registry and the CMS read-only interface`);
  err.code = 'EHEOPRESS_HOST_REFUSED';
  return err;
}

process.on('exit', () => {
  if (refused) process.exitCode = REFUSED_EXIT;
});

const strip = (h) => String(h ?? '').replace(/^\[|\]$/g, '').toLowerCase();

function targetOf(args) {
  const [a, b] = args;
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    if (a.path !== undefined && a.port === undefined) return { path: String(a.path) };
    return { host: strip(a.host ?? 'localhost'), port: String(a.port ?? '') };
  }
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return { host: strip(typeof b === 'string' ? b : 'localhost'), port: String(a) };
  if (typeof a === 'string') return { path: a };
  return { host: '', port: '' };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  // `connect([options, cb])` is also called with an array internally (normalised arguments).
  const flat = Array.isArray(args[0]) ? args[0] : args;
  const t = targetOf(flat);
  if (t.path !== undefined) throw refuse(`unix:${t.path}`);
  const key = `${t.host}:${t.port}`;
  if (!allowed.has(key)) throw refuse(key);
  return originalConnect.apply(this, args);
};

const originalSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function guardedSend(...args) {
  const port = args.find((x, i) => i > 0 && typeof x === 'number');
  const host = args.find((x, i) => i > 1 && typeof x === 'string');
  throw refuse(`udp:${strip(host)}:${port ?? ''}`);
  // eslint-disable-next-line no-unreachable
  return originalSend.apply(this, args);
};

const guardName = (fn) =>
  function guardedLookup(hostname, ...rest) {
    if (!allowedNames.has(strip(hostname))) throw refuse(strip(hostname));
    return fn.call(this, hostname, ...rest);
  };
dns.lookup = guardName(dns.lookup);
dns.promises.lookup = guardName(dns.promises.lookup);
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv']) {
  if (typeof dns[name] === 'function') dns[name] = guardName(dns[name]);
  if (typeof dns.promises[name] === 'function') dns.promises[name] = guardName(dns.promises[name]);
}
