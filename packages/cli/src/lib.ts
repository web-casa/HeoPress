// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Library entry of the `heopress` package.
 *
 * `import { createHeoPressClient } from 'heopress'` is the same client as
 * `@heopress/sdk` — this package re-exports it so a project needs one name in
 * `dependencies` for both the runtime client and the `heopress` CLI. The SDK
 * stays a separate, dependency-free package underneath; nothing here is
 * Node-specific, so this entry is safe to import from browser and edge code.
 */
export * from '@heopress/sdk';
