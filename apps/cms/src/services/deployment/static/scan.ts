import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PLATFORM_CONFIG_FILES } from './contract';

/**
 * The static output scan (HeoPress P11 task 5.2; spec publishing/frontend-deployments, ADR-0017): before a build's output
 * leaves the server, every file is read and the deploy is refused when it carries
 *
 *   - a secret: private keys, provider tokens (Cloudflare, Vercel, Netlify, GitHub, AWS, Stripe-like `sk_live_`), JWTs, a
 *     connection string with a password, or a value of the CMS's own secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, … passed in
 *     `knownSecrets`);
 *   - an administration address: the CMS's own origins (`adminOrigins`) or its admin / API paths (`/admin/`, `/api/v1/`);
 *   - internal data: loopback / private addresses with a port, the page data interface (`/v1/page-data`), database
 *     identifiers (`lumibase_` tables);
 *   - configuration bundled by mistake: `.env*`, `.git`, `.npmrc`, `package.json`, source maps, keys and certificates, or a
 *     platform configuration file (the deployer writes those itself).
 *
 * The scan reads at most `maxBytes` of each text file; binaries (images, fonts) are checked by name only.
 */

export interface ScanIssue {
  file: string;
  rule: string;
  /** A redacted excerpt: the finding's first and last characters only, never the secret. */
  excerpt: string;
}

export interface ScanOptions {
  /** The CMS's origins (`https://cms.example.com`): never linked from the public output. */
  adminOrigins?: string[];
  /** Secret values of this installation, compared literally (at least 8 characters each). */
  knownSecrets?: string[];
  maxBytes?: number;
  maxFiles?: number;
}

const TEXT = /\.(html?|xml|txt|md|json|js|mjs|css|svg|webmanifest|rss|atom|csv|map)$/i;

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['vercel-token', /\bvercel_[A-Za-z0-9]{20,}\b/],
  ['netlify-token', /\bnfp_[A-Za-z0-9]{30,}\b/],
  ['cloudflare-token', /\b(?:CF|CLOUDFLARE)_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/i],
  ['live-secret-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['connection-string', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/"'<>]+:[^\s@/"'<>]+@/i],
  ['secret-assignment', /\b(?:JWT_SECRET|ENCRYPTION_KEY|DATABASE_URL|HEOPRESS_[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD))\s*[=:]/],
];

const INTERNAL_PATTERNS: Array<[string, RegExp]> = [
  ['admin-path', /\b(?:href|src|action|formaction)\s*=\s*["']?[^"'\s>]*\/(?:admin|studio|api\/v1)(?:\/|["'\s>?#]|$)/i],
  ['page-data-interface', /\/v1\/page-data\b/],
  ['internal-address', /\bhttps?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])(?::\d+)?/i],
  ['database-identifier', /\blumibase_[a-z_]{3,}\b/],
];

const BAD_NAMES: Array<[string, RegExp]> = [
  ['env-file', /(^|\/)\.env(\.|$)/],
  ['vcs', /(^|\/)\.(git|svn|hg)(\/|$)/],
  ['package-config', /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|package\.json|pnpm-lock\.yaml|package-lock\.json|tsconfig\.json|astro\.config\.[mc]?[jt]s)$/],
  ['source-map', /\.map$/],
  ['key-material', /\.(pem|key|p12|pfx|crt|der|jks|kdbx)$/i],
  ['dotfile', /(^|\/)\.(?!well-known(\/|$))[^/]+/],
];

const redact = (s: string) => (s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`);

async function walk(dir: string, root: string, out: string[], max: number): Promise<void> {
  for (const name of await readdir(dir)) {
    if (out.length > max) return;
    const full = join(dir, name);
    const st = await lstat(full);
    if (st.isSymbolicLink()) out.push(`${relative(root, full).split(sep).join('/')}\u0000symlink`);
    else if (st.isDirectory()) await walk(full, root, out, max);
    else out.push(relative(root, full).split(sep).join('/'));
  }
}

export async function scanStaticOutput(outDir: string, opts: ScanOptions = {}): Promise<ScanIssue[]> {
  const maxFiles = opts.maxFiles ?? 50_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const known = (opts.knownSecrets ?? []).filter((s) => s.length >= 8);
  const admins = (opts.adminOrigins ?? []).map((o) => o.replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  const files: string[] = [];
  await walk(outDir, outDir, files, maxFiles);
  const issues: ScanIssue[] = [];
  if (files.length > maxFiles) issues.push({ file: '.', rule: 'too-many-files', excerpt: `> ${maxFiles}` });
  for (const entry of files) {
    const [file, flag] = entry.split('\u0000') as [string, string | undefined];
    if (flag === 'symlink') {
      issues.push({ file, rule: 'symlink', excerpt: file });
      continue;
    }
    const top = file.split('/')[0]!;
    if (PLATFORM_CONFIG_FILES.includes(top)) issues.push({ file, rule: 'platform-config', excerpt: top });
    for (const [rule, re] of BAD_NAMES) if (re.test(file)) issues.push({ file, rule, excerpt: file });
    if (!TEXT.test(file)) continue;
    const buf = await readFile(join(outDir, file));
    const text = buf.subarray(0, maxBytes).toString('utf8');
    for (const [rule, re] of [...SECRET_PATTERNS, ...INTERNAL_PATTERNS]) {
      const m = re.exec(text);
      if (m) issues.push({ file, rule, excerpt: redact(m[0].trim()) });
    }
    for (const s of known) if (text.includes(s)) issues.push({ file, rule: 'installation-secret', excerpt: '***' });
    const lower = text.toLowerCase();
    for (const o of admins) if (lower.includes(o)) issues.push({ file, rule: 'admin-origin', excerpt: o });
  }
  return issues;
}
