// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Every build uses the one build template (operator themes are staged under `themes/.operator/`, removed when a
    // file is done): files run one after another so one file's clean-up never lands in another's build.
    fileParallelism: false,
  },
});
