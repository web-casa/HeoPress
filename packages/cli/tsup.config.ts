// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { defineConfig } from "tsup";

export default defineConfig([
  {
    // CLI entry — loaded by `bin/heopress.js`.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: false,
    target: "node22",
    // The typegen core is pure (manifest -> TS source) and tiny. Bundling it keeps
    // the CLI self-contained for `npx heopress`, and avoids a runtime import of
    // @heopress/sdk — which resolves to raw .ts inside the monorepo.
    noExternal: ["@heopress/sdk"],
  },
  {
    // Library entry — `import ... from 'heopress'`. Here the SDK must stay a
    // real runtime dependency (not bundled) so a project that also imports
    // `@heopress/sdk` directly gets one copy of every class (`HeoPressError`
    // instanceof checks) and one set of types.
    entry: ["src/lib.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: false,
    target: "es2022",
    platform: "neutral",
    external: ["@heopress/sdk"],
  },
]);
