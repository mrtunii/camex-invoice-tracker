import { type ComponentType, lazy } from 'react';
import { Navigate, createBrowserRouter } from 'react-router';
import { RequireAuth } from '@/components/require-auth';
import { RootLayout, RouteError } from '@/components/root-layout';

/**
 * Every page is its own chunk (React.lazy), so /login doesn't download the app shell, the
 * chart or HeroUI's heavier components. `pick` turns a named export into what lazy() wants.
 */
function page<M>(load: () => Promise<M>, pick: (module: M) => ComponentType) {
  const Page = lazy(async () => ({ default: pick(await load()) }));
  return <Page />;
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      {
        path: '/login',
        element: page(
          () => import('@/pages/login-page'),
          (m) => m.LoginPage,
        ),
      },
      {
        element: <RequireAuth />,
        children: [
          {
            element: page(
              () => import('@/components/app-layout'),
              (m) => m.AppLayout,
            ),
            children: [
              {
                index: true,
                element: page(
                  () => import('@/pages/home/home-page'),
                  (m) => m.HomePage,
                ),
              },
              {
                path: 'invoices',
                element: page(
                  () => import('@/pages/invoices/invoices-page'),
                  (m) => m.InvoicesPage,
                ),
              },
              {
                path: 'invoices/:id',
                // The split view uses the whole width and height (AppLayout drops its padding).
                handle: { fullBleed: true },
                element: page(
                  () => import('@/pages/invoices/detail/invoice-detail-page'),
                  (m) => m.InvoicePage,
                ),
              },
              {
                path: 'inbox',
                element: page(
                  () => import('@/pages/inbox/inbox-page'),
                  (m) => m.InboxPage,
                ),
              },
              {
                path: 'vendors',
                element: page(
                  () => import('@/pages/vendors/vendors-page'),
                  (m) => m.VendorsPage,
                ),
              },
              {
                path: 'team',
                element: page(
                  () => import('@/pages/team/team-page'),
                  (m) => m.TeamPage,
                ),
              },
              // The Team page was called Users until T05b.
              { path: 'users', element: <Navigate to="/team" replace /> },
              {
                path: '*',
                element: page(
                  () => import('@/pages/not-found-page'),
                  (m) => m.NotFoundPage,
                ),
              },
            ],
          },
        ],
      },
    ],
  },
]);
