import type { AuthUser } from '@camex/shared';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isPasswordChangeRequired, isUnauthorized } from './api';

export const meQueryKey = ['auth', 'me'] as const;

/**
 * Any 401 means the session is gone (expired, logged out elsewhere, user deactivated):
 * clearing the current user makes <RequireAuth> redirect to /login. A 403
 * PASSWORD_CHANGE_REQUIRED (e.g. an admin reset the password meanwhile) flags the current user,
 * which makes <RequireAuth> show the "Set a new password" screen.
 */
function onError(error: unknown) {
  if (isUnauthorized(error)) {
    queryClient.setQueryData(meQueryKey, null);
  } else if (isPasswordChangeRequired(error)) {
    queryClient.setQueryData<AuthUser | null>(meQueryKey, (user) =>
      user ? { ...user, mustChangePassword: true } : user,
    );
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !isUnauthorized(error) && !isPasswordChangeRequired(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});
