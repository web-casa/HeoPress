// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
type SetupRuntimeEnv = Pick<
  ImportMetaEnv,
  'PROD' | 'VITE_HEOPRESS_ALLOW_ADMIN_PATH_REDIRECT' | 'VITE_HEOPRESS_RELEASE_CHANNEL'
>;

export function shouldAutoRedirectToAdmin(env: SetupRuntimeEnv = import.meta.env): boolean {
  const releaseChannel = env.VITE_HEOPRESS_RELEASE_CHANNEL?.trim().toLowerCase();
  const allowRedirectOverride =
    env.VITE_HEOPRESS_ALLOW_ADMIN_PATH_REDIRECT?.trim().toLowerCase() === 'true';

  return allowRedirectOverride || (env.PROD !== true && releaseChannel !== 'production');
}
