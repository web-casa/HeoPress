import type { RenderPort } from './read-port';

type HostRow = Awaited<ReturnType<RenderPort['host']>>;
const HOST_MEMO_SIZE = 10_000;

/**
 * Hosts read through a short in-process memory (HeoPress P13 task 3.2): a cache hit is one statement instead of two.
 * The memory lasts `ms` (0: none; the caller keeps it within design P06 R8's 2 s), so a removed or moved domain answers
 * as before for at most that long. Unknown hosts are remembered too (a stream of made-up names costs one read per name
 * and window); past `HOST_MEMO_SIZE` names the oldest go. A failed read is not remembered.
 */
export function hostMemo(port: Pick<RenderPort, 'host'>, ms: number, clock: () => number = performance.now.bind(performance)) {
  if (ms <= 0) return (host: string) => port.host(host);
  const memo = new Map<string, { row: Promise<HostRow>; until: number }>();
  return (host: string): Promise<HostRow> => {
    const t = clock();
    const hit = memo.get(host);
    if (hit && hit.until > t) return hit.row;
    memo.delete(host);
    const row = port.host(host);
    memo.set(host, { row, until: t + ms });
    row.catch(() => {
      if (memo.get(host)?.row === row) memo.delete(host);
    });
    for (const old of memo.keys()) {
      if (memo.size <= HOST_MEMO_SIZE) break;
      memo.delete(old);
    }
    return row;
  };
}
