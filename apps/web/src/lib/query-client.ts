import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isUnauthorized } from './api';

export const meQueryKey = ['auth', 'me'] as const;

/**
 * Any 401 means the session is gone (expired, logged out elsewhere, user deactivated):
 * clearing the current user makes <RequireAuth> redirect to /login.
 */
function onError(error: unknown) {
  if (isUnauthorized(error)) queryClient.setQueryData(meQueryKey, null);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});
