// ESLint for the HeoPress distribution (P01 task 4.3; ADR-0017).
//
// Deliberately small: the rules below catch defects (unhandled promises,
// promises passed where a value is expected, eval-like code, broken hooks) or
// enforce an AGENTS.md convention (no `any`). Existing upstream violations are
// frozen in eslint-suppressions.json, so CI fails only on new ones:
//   pnpm lint                                  # check
//   pnpm exec eslint --prune-suppressions      # after fixing suppressed code
// Do not run `--suppress-all` to make a new violation pass.
//
// Type-aware linting loads every TypeScript project at once: about 4.6 GB peak,
// hence the raised heap in the root `lint` script (CI runners have 7 GB).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const TS_FILES = ['apps/cms/src/**/*.{ts,tsx}', 'apps/studio/src/**/*.{ts,tsx}', 'apps/site-classic/src/**/*.ts', 'packages/*/src/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      'docs/**',
    ],
  },
  {
    linterOptions: {
      // Upstream disable comments name rules this config does not enable
      // (no-console, no-var, ...); they are harmless, so do not report them.
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: TS_FILES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['apps/studio/src/**/*.tsx', 'apps/studio/src/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // One HTTP outlet (HeoPress P04, spec sites/site-switching): every request
    // goes through lib/http.ts, so a site switch can hold new requests, wait
    // for writes in flight, and renew the session once across tabs.
    files: ['apps/studio/src/**/*.tsx', 'apps/studio/src/**/*.ts'],
    ignores: ['apps/studio/src/**/__tests__/**', 'apps/studio/src/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'Use siteFetch / publicFetch from @/lib/http (one outlet for site switching).',
        },
        {
          selector: "CallExpression[callee.object.name=/^(window|globalThis|self)$/][callee.property.name='fetch']",
          message: 'Use siteFetch / publicFetch from @/lib/http (one outlet for site switching).',
        },
      ],
    },
  },
);
