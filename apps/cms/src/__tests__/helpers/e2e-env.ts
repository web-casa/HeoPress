/**
 * The environment an end-to-end suite needs **besides** `DATABASE_URL`.
 *
 * The database suites need `DATABASE_URL`, and the full CMS run sets it. An E2E suite needs more than that — the app boots
 * in a different mode without `JWT_SECRET` (and, for the golden path, without `HEOPRESS_RUNTIME=docker`), and the first
 * request answers 500. Guarding only on the database therefore turns a missing prerequisite into what looks like a
 * product failure: it happened with the golden path, the Change Feed and search in one full run.
 *
 * Every E2E suite lists what it needs here so the skip message names the variables to set, and so the requirement is
 * one place instead of a comment per file.
 */
export interface E2EPrerequisiteOptions {
  /** `true` for suites that drive the Docker runtime (the golden path boots `serve.ts`). */
  runtime?: boolean;
  /** Any further variable by name, e.g. `HEOPRESS_ENV`. */
  also?: string[];
}

/** The variables this process is missing, in the order to report them (`[]` when the suite can run). */
export function missingE2EEnv(options: E2EPrerequisiteOptions = {}): string[] {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL?.trim()) missing.push('DATABASE_URL');
  if (!process.env.JWT_SECRET?.trim()) missing.push('JWT_SECRET');
  if (options.runtime && process.env.HEOPRESS_RUNTIME !== 'docker') missing.push('HEOPRESS_RUNTIME=docker');
  for (const name of options.also ?? []) if (!process.env[name]?.trim()) missing.push(name);
  return missing;
}
