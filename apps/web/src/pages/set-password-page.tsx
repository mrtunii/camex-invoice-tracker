import type { AuthUser } from '@camex/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { ChangePasswordFields } from '@/components/change-password-form';
import { useChangePasswordForm } from '@/lib/change-password';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLogout } from '@/lib/auth';
import { useCurrentUser } from '@/lib/current-user';
import { meQueryKey } from '@/lib/query-client';

/**
 * Full-page gate shown instead of the app while the password was set by someone else
 * (bootstrap admin, new user, admin reset). The API refuses everything else until it's done.
 */
export function SetPasswordPage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const { form, pending, onSubmit } = useChangePasswordForm(() => {
    queryClient.setQueryData<AuthUser | null>(meQueryKey, (me) =>
      me ? { ...me, mustChangePassword: false } : me,
    );
    toast.success('Password set. Welcome!');
  });

  useEffect(() => {
    document.title = 'Set a new password – Camex Invoice Tracker';
  }, []);

  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight">Camex</span>
          <span className="text-muted-foreground">Invoice Tracker</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Set a new password</CardTitle>
            <CardDescription>
              Your password for <span className="font-mono">{user.email}</span> was set by someone
              else. Choose your own to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={(e) => void onSubmit(e)} className="space-y-5">
              <ChangePasswordFields
                form={form}
                currentLabel="Current (temporary) password"
                idPrefix="set-password"
              />
              <Button type="submit" className="w-full" size="lg" disabled={pending}>
                {pending ? 'Saving…' : 'Set password and continue'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Not you?{' '}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => logout.mutate()}
          >
            Sign out
          </button>
        </p>
      </div>
    </main>
  );
}
