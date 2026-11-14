/**
 * Unit tests of the corrections plugin: the form's validation, the correction block in a body, the notice a report
 * becomes, the gate verdict and the package as it ships (the manifest carries templates/, the bundle is one module that
 * imports nothing at run time). The plugin against a real CMS is
 * apps/cms/src/__tests__/corrections-plugin.db.integration.test.ts.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
