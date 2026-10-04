import { Button } from '@heroui/react';
import { lazy } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '@/lib/auth';
import { CurrentUserContext } from '@/lib/current-user';

const SetPasswordPage = lazy(async () => ({
  default: (await import('@/pages/set-password-page')).SetPasswordPage,
}));

/**
 * Route gate: renders children only with a valid session, otherwise redirects to /login.
 * A user who must change their password sees only the "Set a new password" screen.
 */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return <div className="min-h-svh" aria-busy="true" />;
  }
  if (me.isError) {
    return (
      <main className="grid min-h-svh place-items-center px-4">
        <div className="max-w-sm space-y-3 text-center">
          <p>{me.error.message}</p>
          <Button variant="outline" onPress={() => void me.refetch()}>
            Try again
          </Button>
        </div>
      </main>
    );
  }
  if (!me.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return (
    <CurrentUserContext.Provider value={me.data}>
      {me.data.mustChangePassword ? <SetPasswordPage /> : <Outlet />}
    </CurrentUserContext.Provider>
  );
}
