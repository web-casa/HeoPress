/**
 * Unit tests of the glossary plugin: the term linker, the citation verdict and the package as it ships (the manifest
 * carries templates/, the bundle is one module that imports nothing at run time). The plugin against a real CMS is
 * apps/cms/src/__tests__/glossary-plugin.db.integration.test.ts.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
