import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
// The plan is plain JavaScript shared with scripts/test-shards.mjs (its tests: scripts/__tests__/test-shards.test.mjs).
import { planShards } from '../../scripts/test-shards.mjs';

/**
 * `--shard <index>/<count>` by measured duration instead of file count (scripts/test-shards.mjs): the CMS files run
 * one at a time against one database, so shards of equal counts finish minutes apart. The plan depends only on the
 * file list and `test-shard-timings.json`, so every shard job computes the same one and each file runs in exactly
 * one shard; `node scripts/quality.mjs pr --group db --merge-shards <count>` checks that the merged report holds
 * every test file. Ordering within a shard is Vitest's (BaseSequencer.sort).
 */
export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const root = this.ctx.config.root;
    const timings = JSON.parse(readFileSync(new URL('./test-shard-timings.json', import.meta.url), 'utf8'));
    const relative = (spec: TestSpecification) => path.relative(root, spec.moduleId).split(path.sep).join('/');
    const { shards, seconds } = planShards(files.map(relative), timings, shard.count);
    const mine = new Set(shards[shard.index - 1]);
    const selected = files.filter((spec) => mine.has(relative(spec)));
    console.log(
      `[shards] ${shard.index}/${shard.count}: ${selected.length} of ${files.length} test files, about ${Math.round(seconds[shard.index - 1] ?? 0)} s by test-shard-timings.json`,
    );
    return selected;
  }
}
