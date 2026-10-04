import { Button, RouterProvider, Spinner } from '@heroui/react';
import { Suspense } from 'react';
import { Outlet, useHref, useNavigate, useRouteError } from 'react-router';

/** While a page's code loads. */
export function PageFallback() {
  return (
    <div className="grid min-h-48 place-items-center" aria-busy="true">
      <Spinner size="sm" color="current" className="text-muted" aria-label="Loading" />
    </div>
  );
}

/**
 * The root of every route: HeroUI (React Aria) links and link-like rows navigate through
 * react-router instead of reloading the page.
 */
export function RootLayout() {
  const navigate = useNavigate();
  return (
    <RouterProvider navigate={(path) => void navigate(path)} useHref={useHref}>
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </RouterProvider>
  );
}

/** A route failed to render, typically a page chunk that a new deploy has replaced. */
export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : null;
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4">
      <div className="max-w-sm space-y-4 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-muted">
          Reload the page to try again. If you were just signed in, nothing was lost.
        </p>
        {message !== null && <p className="text-xs break-words text-muted">{message}</p>}
        <Button onPress={() => window.location.reload()}>Reload</Button>
      </div>
    </main>
  );
}
