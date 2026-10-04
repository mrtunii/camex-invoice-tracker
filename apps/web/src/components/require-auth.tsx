import { Navigate, Outlet, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth';
import { CurrentUserContext } from '@/lib/current-user';

/** Route gate: renders children only with a valid session, otherwise redirects to /login. */
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
          <p className="text-base">{me.error.message}</p>
          <Button variant="outline" onClick={() => void me.refetch()}>
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
      <Outlet />
    </CurrentUserContext.Provider>
  );
}
