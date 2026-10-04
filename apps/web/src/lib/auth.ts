import { type AuthUser, type LoginRequest, authResponseSchema } from '@camex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiNoContent, isUnauthorized } from './api';
import { meQueryKey } from './query-client';

async function fetchMe(): Promise<AuthUser | null> {
  try {
    return (await api('/auth/me', authResponseSchema)).user;
  } catch (error) {
    if (isUnauthorized(error)) return null;
    throw error;
  }
}

/** The signed-in user; `null` when there is no valid session. */
export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: fetchMe, staleTime: 5 * 60_000 });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) =>
      api('/auth/login', authResponseSchema, { method: 'POST', body }),
    onSuccess: ({ user }) => queryClient.setQueryData(meQueryKey, user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiNoContent('/auth/logout', { method: 'POST' }),
    // Signed out either way (a 401 means the session was already gone).
    // Update `me` in place (don't clear() it: <RequireAuth> observes that query and redirects
    // on null), then drop everything cached for the previous user.
    onSettled: () => {
      queryClient.setQueryData(meQueryKey, null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meQueryKey[0] });
    },
  });
}
