/**
 * The instance's service states for the status cards (HeoPress P07a task 11.5): the health checks, read within a time
 * limit. A check that cannot be read in time — or fails — is `unknown`, never `ok`.
 */
export async function servicesWithin(
  collect: () => Promise<Record<string, string>>,
  names: readonly string[],
  timeoutMs: number,
): Promise<Record<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const health = await Promise.race([
    collect(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
  return Object.fromEntries(names.map((name) => [name, health ? (health[name] ?? 'unknown') : 'unknown']));
}
