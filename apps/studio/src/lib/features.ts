import { useQuery } from '@tanstack/react-query';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { siteFetch } from '@/lib/http';

/**
 * Optional server features (P02 task 5.1). The CMS reports which ones this
 * instance runs (`GET /api/v1/features`); entry points of the others are hidden.
 * Until the answer arrives every feature counts as off, so nothing is offered
 * that the server would refuse.
 */
export interface ServerFeatures {
  graphql: boolean;
  agentNewsroom: boolean;
  contentGoals: boolean;
  externalIssuers: boolean;
  loginAnomaly: boolean;
  metrics: boolean;
  fieldEncryption: boolean;
}

export const NO_FEATURES: ServerFeatures = {
  graphql: false,
  agentNewsroom: false,
  contentGoals: false,
  externalIssuers: false,
  loginAnomaly: false,
  metrics: false,
  fieldEncryption: false,
};

export async function fetchServerFeatures(): Promise<ServerFeatures> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await siteFetch('/api/v1/features', {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-HeoPress-Site': site } : {}),
      'X-HeoPress-Client': 'studio',
    },
  });
  if (!res.ok) return NO_FEATURES;
  const body = (await res.json().catch(() => ({}))) as { data?: Partial<ServerFeatures> };
  return { ...NO_FEATURES, ...(body.data ?? {}) };
}

export function useServerFeatures(): ServerFeatures {
  const query = useQuery({ queryKey: ['server-features'], queryFn: fetchServerFeatures, staleTime: 5 * 60_000 });
  return query.data ?? NO_FEATURES;
}
