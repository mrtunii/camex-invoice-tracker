import { Navigate, createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/app-layout';
import { RequireAuth } from '@/components/require-auth';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { PlaceholderPage } from '@/pages/placeholder-page';
import { UsersPage } from '@/pages/users/users-page';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/invoices" replace /> },
          {
            path: 'invoices',
            element: (
              <PlaceholderPage title="Invoices">
                Invoices emailed to invoices@camex.aero or uploaded here will be listed for review.
              </PlaceholderPage>
            ),
          },
          {
            path: 'inbox',
            element: (
              <PlaceholderPage title="Inbox">
                Every email received at invoices@camex.aero will be logged here, including ones
                without a PDF.
              </PlaceholderPage>
            ),
          },
          {
            path: 'vendors',
            element: (
              <PlaceholderPage title="Vendors">
                Vendors, their payment terms and trusted bank accounts will be managed here.
              </PlaceholderPage>
            ),
          },
          { path: 'users', element: <UsersPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
