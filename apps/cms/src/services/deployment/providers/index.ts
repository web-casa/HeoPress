// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { registerProvider } from './provider';
import { vercelProvider } from './vercel';
import { netlifyProvider } from './netlify';
import { cloudflarePagesProvider } from './cloudflare-pages';

/**
 * Register the built-in deployment providers. Importing this module wires the
 * registry; the DeploymentService imports it for its side effect.
 */
registerProvider(vercelProvider);
registerProvider(netlifyProvider);
registerProvider(cloudflarePagesProvider);

export * from './provider';
export { vercelProvider, mapVercelStatus } from './vercel';
export { netlifyProvider, mapNetlifyStatus } from './netlify';
