// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type {
  HitContext,
  PageviewStats,
  PageviewStrategy,
  StatsRange,
  StrategyDeps,
} from '../strategy';
import { DbRollupStrategy } from './db-rollup';

/**
 * CDC strategy — for an external pipeline (e.g. Debezium into ClickHouse) that aggregates hits from the database's
 * change stream: every hit is a row of `lumibase_pageview_events`, written by the local daily rollup, which also keeps
 * the Studio panel's read model (per the product decision: the panel reads the local rollup, ClickHouse is external).
 *
 * It used to also queue each hit on a `pageview-cdc` job queue that no process consumed; that emit is gone
 * (HeoPress P14 task 5.3, spec platform/infrastructure-adapters "入队的任务必有消费者"). An external pipeline reads
 * the table's changes, not the job queue.
 */
export class CdcEventStrategy implements PageviewStrategy {
  readonly name = 'cdc' as const;

  private readonly local: DbRollupStrategy;

  constructor(deps: StrategyDeps) {
    this.local = new DbRollupStrategy(deps);
  }

  async recordHit(siteId: string, ctx: HitContext): Promise<void> {
    await this.local.recordHit(siteId, ctx);
  }

  async getStats(siteId: string, range: StatsRange): Promise<PageviewStats> {
    return this.local.getStats(siteId, range);
  }
}
