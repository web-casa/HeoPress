// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/** Build an absolute path for navigation, honouring the admin-path prefix. */
export function withAdminBase(adminBase: string, to: string): string {
  return `${adminBase}${to === '/' ? '' : to}` || '/';
}
