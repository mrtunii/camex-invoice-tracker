import { Navigate, createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/app-layout';
import { RequireAuth } from '@/components/require-auth';
import { InboxPage } from '@/pages/inbox/inbox-page';
import { InvoicePage } from '@/pages/invoices/invoice-page';
import { InvoicesPage } from '@/pages/invoices/invoices-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { UsersPage } from '@/pages/users/users-page';
import { VendorsPage } from '@/pages/vendors/vendors-page';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/invoices" replace /> },
          { path: 'invoices', element: <InvoicesPage /> },
          { path: 'invoices/:id', element: <InvoicePage /> },
          { path: 'inbox', element: <InboxPage /> },
          { path: 'vendors', element: <VendorsPage /> },
          { path: 'users', element: <UsersPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
