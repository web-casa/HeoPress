// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'policy/index': 'src/policy/index.ts',
    'field/index': 'src/field/index.ts',
    'schemas/index': 'src/schemas/index.ts',
    'extensions/index': 'src/extensions/index.ts',
    version: 'src/version.ts',
    'utils/logger': 'src/utils/logger.ts',
    'theme/index': 'src/theme/index.ts',
    // A deployment's template imports this from Node, which cannot load the TypeScript source the package exports.
    'theme/page-data': 'src/theme/page-data.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
