import type { SiteSummary } from '../api';

/**
 * Topology layout (HeoPress P07a task 9.1; ADR-0019 §19): the deployment in the middle, the sites on a ring around it.
 * Deterministic — the same sites give the same places (sorted by name, then id). Past 24 sites the ring is split into
 * six sectors — the four health states, then "needs two-step verification" and "temporarily unavailable" — so nodes
 * never overlap. Never an edge between two sites (the compliance boundary).
 */

export const GROUPS = ['bad', 'warn', 'unknown', 'ok', 'mfa_required', 'unavailable'] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_THRESHOLD = 24;

interface NodePlace {
  site: SiteSummary;
  x: number;
  y: number;
  group: Group;
}

export interface Layout {
  center: { x: number; y: number };
  radius: number;
  nodes: NodePlace[];
  grouped: boolean;
  /** Sectors when grouped: the group and its angle range (radians). */
  sectors: Array<{ group: Group; from: number; to: number; count: number }>;
}

export function groupOf(site: SiteSummary): Group {
  if (site.availability === 'mfa_required') return 'mfa_required';
  if (site.availability === 'unavailable' || !('health' in site)) return 'unavailable';
  return site.health.status;
}

const byName = (a: SiteSummary, b: SiteSummary) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export function layoutTopology(sites: readonly SiteSummary[], size: { width: number; height: number }): Layout {
  const center = { x: size.width / 2, y: size.height / 2 };
  const radius = Math.max(60, Math.min(size.width, size.height) / 2 - 70);
  const sorted = [...sites].sort(byName);
  const at = (angle: number) => ({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  const start = -Math.PI / 2;

  if (sorted.length <= GROUP_THRESHOLD) {
    const step = (2 * Math.PI) / Math.max(sorted.length, 1);
    return {
      center,
      radius,
      grouped: false,
      sectors: [],
      nodes: sorted.map((site, i) => ({ site, group: groupOf(site), ...at(start + i * step) })),
    };
  }

  const members = GROUPS.map((group) => ({ group, sites: sorted.filter((s) => groupOf(s) === group) })).filter((g) => g.sites.length);
  // Each sector's share of the ring follows its size, with a small gap between sectors.
  const gap = 0.12;
  const usable = 2 * Math.PI - gap * members.length;
  const nodes: NodePlace[] = [];
  const sectors: Layout['sectors'] = [];
  let angle = start;
  for (const g of members) {
    const span = (usable * g.sites.length) / sorted.length;
    const step = span / g.sites.length;
    g.sites.forEach((site, i) => nodes.push({ site, group: g.group, ...at(angle + step * (i + 0.5)) }));
    sectors.push({ group: g.group, from: angle, to: angle + span, count: g.sites.length });
    angle += span + gap;
  }
  return { center, radius, grouped: true, sectors, nodes };
}

/** AI platforms placed on an outer arc, in order of total referrals (then name). */
export function platformsOf(sites: readonly SiteSummary[]): Array<{ operator: string; hits: number }> {
  const totals = new Map<string, number>();
  for (const s of sites) {
    if (!('referralsByPlatform' in s)) continue;
    for (const p of s.referralsByPlatform) totals.set(p.operator, (totals.get(p.operator) ?? 0) + p.hits);
  }
  return [...totals].map(([operator, hits]) => ({ operator, hits })).sort((a, b) => b.hits - a.hits || a.operator.localeCompare(b.operator));
}
