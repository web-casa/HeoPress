/** `{ shell: {...}, overview: {...} }` from one language's JSON files (`../<lang>/<namespace>.json`). */
export function namespacesOf(files: Record<string, { default: Record<string, unknown> }>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, mod] of Object.entries(files)) {
    const ns = /\/([^/]+)\.json$/.exec(path)?.[1];
    if (ns) out[ns] = mod.default;
  }
  return out;
}
