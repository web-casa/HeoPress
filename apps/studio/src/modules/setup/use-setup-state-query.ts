// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery, type Query } from '@tanstack/react-query';
import {
  fetchSetupState,
  type SetupStateFetchError,
  type SetupStateResponse,
} from './setup-state';

/**
 * Shared TanStack Query key for `GET /api/v1/setup/state`.
 *
 * Both `SetupStateGate` (wizard) and `AdminReadyGate` (AppShell) read the
 * same endpoint; a single key lets them share cache when the operator
 * navigates between `/` and `/setup`.
 */
export const SETUP_STATE_QUERY_KEY = ['setup', 'state'] as const;

/**
 * Auto-refetch only while the last result was successful.
 *
 * When the API is unreachable the gates render a stable error screen and
 * wait for an explicit "Try again". Refetch-on-focus / reconnect would
 * otherwise hammer a down backend and feel like a continuous page refresh
 * (`staleTime: 0` makes every focus a network round-trip).
 */
function refetchWhenHealthy(
  query: Query<SetupStateResponse, SetupStateFetchError>,
): boolean {
  return query.state.status === 'success';
}

/**
 * A 429 is not an unreachable server: the per-IP limit on `/setup/state` (60 a minute by default) can be reached when
 * several people share one address. Wait and ask again — three times, 20 seconds apart, which spans the limit's window.
 */
export function retryWhenRateLimited(failureCount: number, error: SetupStateFetchError): boolean {
  return error.status === 429 && failureCount < 3;
}

const RATE_LIMIT_RETRY_MS = 20_000;

/**
 * Gate query for setup state. Always fetches fresh data on first mount
 * (`staleTime: 0`) but does not auto-retry after a failure (except a 429, see
 * `retryWhenRateLimited`) — the operator
 * must click "Try again".
 */
export function useSetupStateQuery() {
  return useQuery<SetupStateResponse, SetupStateFetchError>({
    queryKey: SETUP_STATE_QUERY_KEY,
    queryFn: fetchSetupState,
    staleTime: 0,
    // Keep a failed result briefly so a remount does not flash the spinner
    // and immediately re-fire while the API is still down.
    gcTime: 60_000,
    retry: retryWhenRateLimited,
    retryDelay: RATE_LIMIT_RETRY_MS,
    refetchOnWindowFocus: refetchWhenHealthy,
    refetchOnReconnect: refetchWhenHealthy,
  });
}

/**
 * Whether the setup-state gate should render the unreachable alert.
 *
 * TanStack Query can flip an errored query (no cached data) back to
 * `status: 'pending'` for the duration of a manual `refetch()`. Without a
 * sticky flag that would replace the alert with the full-page spinner and
 * look like a continuous refresh. Stick to the alert until a fetch
 * succeeds.
 */
export function shouldShowSetupStateError(query: {
  isError: boolean;
  isSuccess: boolean;
  isFetching: boolean;
  /** Latched true after the first failure until the next success. */
  hasFailed: boolean;
}): boolean {
  if (query.isSuccess) return false;
  return query.isError || query.hasFailed;
}
