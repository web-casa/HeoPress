/** Agent access (HeoPress P10): shapes of `/api/v1/agent-access/*`. */

export const TOOL_GROUPS = ['read', 'content', 'publish', 'settings', 'theme'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

interface SiteChoice {
  id: string;
  name: string;
}

export interface ConsentRequestView {
  client: { id: string; name: string | null; redirectHost: string };
  requestedGroups: ToolGroup[] | null;
  groups: ToolGroup[];
  sites: SiteChoice[];
  resource: string;
}

export interface AgentGrant {
  id: string;
  kind: 'oauth' | 'pat';
  name: string;
  clientId: string | null;
  siteIds: string[];
  toolGroups: ToolGroup[];
  tokenPrefix: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface GrantsView {
  grants: AgentGrant[];
  sites: SiteChoice[];
  groups: ToolGroup[];
  mcpEndpoint: string;
}

/** The groups a consent may grant: those the agent asked for, or all when it named none. */
export function grantableGroups(view: Pick<ConsentRequestView, 'requestedGroups' | 'groups'>): ToolGroup[] {
  return view.requestedGroups ? view.groups.filter((g) => view.requestedGroups!.includes(g)) : view.groups;
}

/** Toggle `value` in `list`, keeping the canonical order of `order`. */
export function toggle<T>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return order.filter((v) => next.includes(v));
}
