/**
 * Dependency boundaries (HeoPress P02 task 8.1, ADR-0017 §1).
 *
 *   pnpm deps:check      CI: fails only on violations not in the baseline
 *   pnpm deps:baseline   rewrite .dependency-cruiser-known-violations.json
 *
 * Existing violations are frozen in the baseline like the ESLint suppressions:
 * fix them and re-run deps:baseline to shrink it; never re-run it to let a new
 * violation through. The theme contract and the extension types live in
 * `@heopress/contracts` (`./theme`, `./extensions`) and are covered by
 * `public-packages-stay-public` (P07 task 7.9).
 */

/**
 * Core-internal workspace packages: by resolved path (workspace symlinks,
 * relative imports) and by name (an import of a package the importer does not
 * declare does not resolve, so only its name is known).
 */
const CORE_INTERNAL =
  '^(packages/(database|runtime|ai-skills|mcp-server|cli|extension-cli)/|apps/cms/)' +
  '|^(@heopress/(database|runtime|ai-skills|mcp-server|extension-cli|cms)|heopress)(/|$)' +
  '|node_modules/(@heopress/(database|runtime|ai-skills|mcp-server|extension-cli|cms)|heopress)/';

/**
 * Business code: CMS modules and services. A module's own HTTP adapter
 * (`routes.ts`, `middleware.ts`) belongs to the HTTP layer and is exempt; so
 * are tests.
 */
const BUSINESS = {
  path: '^apps/cms/src/(modules|services)/',
  pathNot: '/__tests__/|\\.test\\.tsx?$|/(routes|middleware)\\.ts$',
};

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'studio-only-public-contracts',
      comment:
        'Studio talks to the CMS over HTTP. It may use the public contracts, the SDK, the UI kit and extension ' +
        'discovery; never the database, runtime, AI skills, MCP server or CMS source.',
      severity: 'error',
      from: { path: '^apps/studio/' },
      to: { path: CORE_INTERNAL },
    },
    {
      name: 'public-packages-stay-public',
      comment:
        'The SDK, the Extension SDK and the contracts (theme contract, extension types) are published (Apache-2.0, ' +
        'ADR-0008 §4) and used outside this repo; they must not reach into core-internal packages or the apps.',
      severity: 'error',
      from: { path: '^packages/(sdk|extension-sdk|contracts)/' },
      to: { path: `${CORE_INTERNAL}|^apps/` },
    },
    {
      name: 'public-site-no-http-no-cms',
      comment:
        'The public-site read layer (P06 design §0) is shared by the CMS and the rendering service: no HTTP ' +
        'framework, no CMS source, no database access of its own (callers supply a read port).',
      severity: 'error',
      from: { path: '^packages/public-site/' },
      to: { path: '^apps/|^(hono|@hono/)|node_modules/(hono|@hono/)|^packages/(database|runtime|ai-skills|mcp-server)/|^@heopress/(database|runtime|ai-skills|mcp-server|cms)(/|$)|node_modules/@heopress/(database|runtime|cms)/' },
    },
    {
      name: 'seo-geo-pure',
      comment:
        'The SEO / GEO data layer (HeoPress P07 design, Apache-2.0) is pure functions over settings and public page ' +
        'data: no HTTP framework, no database, no runtime, no app source — only the shared contracts.',
      severity: 'error',
      from: { path: '^packages/seo-geo/' },
      to: { path: `${CORE_INTERNAL}|^apps/|^packages/(public-site|ui|sdk)/|^(hono|@hono/)|node_modules/(hono|@hono/)|^@heopress/(public-site|ui|sdk)(/|$)` },
    },
    {
      name: 'site-classic-no-cms',
      comment:
        'The rendering service is its own process with the read-only rendering role (P06 design §0, R20): it never ' +
        'imports CMS source (services, routes, permissions, MCP) — only the public-site layer, the database ' +
        'schema and the runtime.',
      severity: 'error',
      from: { path: '^apps/site-classic/' },
      to: { path: '^apps/(cms|studio)/|^@heopress/(cms|ai-skills|mcp-server)(/|$)|node_modules/@heopress/(cms|ai-skills|mcp-server)/' },
    },
    {
      name: 'business-no-hono',
      comment:
        'Business modules and services take plain arguments, not a Hono Context: the HTTP layer (routes, ' +
        'middleware) adapts the request. Keeps them callable from workers, MCP tools and tests.',
      severity: 'error',
      from: BUSINESS,
      to: { path: 'node_modules/hono/' },
    },
    {
      name: 'business-no-http-or-mcp-transport',
      comment:
        'Business modules and services must not depend back on the HTTP routes and middleware (which include the ' +
        'MCP endpoint), on an MCP transport, or on the MCP server package.',
      severity: 'error',
      from: BUSINESS,
      to: {
        path: [
          '^apps/cms/src/(routes|middleware)/',
          'node_modules/@modelcontextprotocol/sdk/dist/(esm|cjs)/server/(stdio|sse|streamableHttp)',
          '^@modelcontextprotocol/sdk/server/(stdio|sse|streamableHttp)',
          '^packages/mcp-server/|^@heopress/mcp-server(/|$)|node_modules/@heopress/mcp-server/',
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Resolve through the pnpm symlinks (apps/cms/node_modules/hono/...) rather
    // than the store path (node_modules/.pnpm/hono@<version>/...), so a
    // dependency upgrade does not turn every known violation into a new one.
    preserveSymlinks: true,
    exclude: { path: '^(apps|packages)/[a-z-]+/(dist|coverage)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
