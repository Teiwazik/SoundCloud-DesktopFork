// Local subscription gating disabled by author's request — premium features
// are always enabled on the client. Real entitlement is enforced backend-side.

import type { UseQueryResult } from '@tanstack/react-query';

export function getIsPremium(): boolean {
  return true;
}

export function useSubscription(_enabled: boolean): UseQueryResult<boolean> {
  return {
    data: true,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    isError: false,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
    refetch: async () => ({ data: true }) as never,
  } as unknown as UseQueryResult<boolean>;
}
