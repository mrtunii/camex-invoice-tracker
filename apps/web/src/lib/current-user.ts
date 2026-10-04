import type { AuthUser } from '@camex/shared';
import { createContext, useContext } from 'react';

export const CurrentUserContext = createContext<AuthUser | null>(null);

/** The signed-in user. Only usable below <RequireAuth>. */
export function useCurrentUser(): AuthUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('useCurrentUser() must be used below <RequireAuth>');
  return user;
}
