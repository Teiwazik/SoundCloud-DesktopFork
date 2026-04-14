import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { api } from './api';

interface SubscriptionResponse {
  premium: boolean;
}

const QUERY_KEY = ['me', 'subscription'] as const;

let cachedPremium = false;

export function getIsPremium(): boolean {
  return cachedPremium;
}

async function fetchSubscription(): Promise<SubscriptionResponse> {
  const res = await api<SubscriptionResponse>('/me/subscription');
  cachedPremium = res.premium;
  return res;
}

export function useSubscription(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchSubscription,
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
    select: (d) => d.premium,
  });
}

useAuthStore.subscribe((state, prev) => {
  if (state.isAuthenticated && !prev.isAuthenticated) {
    fetchSubscription().catch(() => {});
  }
});

if (useAuthStore.getState().isAuthenticated) {
  fetchSubscription().catch(() => {});
}
