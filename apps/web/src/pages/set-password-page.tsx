import type { AuthUser } from '@camex/shared';
import { Button, Form, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AppToasts } from '@/components/app-toasts';
import { AuthScreen } from '@/components/auth-screen';
import { ChangePasswordFields } from '@/components/change-password-form';
import { useDocumentTitle } from '@/lib/document-title';
import { useLogout } from '@/lib/auth';
import { useChangePasswordForm } from '@/lib/change-password';
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
  useDocumentTitle('Set a new password');
  const { form, pending, onSubmit } = useChangePasswordForm(() => {
    queryClient.setQueryData<AuthUser | null>(meQueryKey, (me) =>
      me ? { ...me, mustChangePassword: false } : me,
    );
    toast.success('Password set. Welcome!');
  });

  return (
    <AuthScreen
      title="Set a new password"
      description={
        <>
          Your password for <span className="font-medium text-foreground">{user.email}</span> was
          set by someone else. Choose your own to continue.
        </>
      }
      footer={
        <p className="text-center text-muted">
          Not you?{' '}
          <Button
            variant="ghost"
            size="sm"
            onPress={() => logout.mutate()}
            className="align-baseline"
          >
            Sign out
          </Button>
        </p>
      }
    >
      <Form
        validationBehavior="aria"
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-4"
      >
        <ChangePasswordFields form={form} currentLabel="Current (temporary) password" />
        <Button type="submit" fullWidth isPending={pending} className="mt-2">
          {pending ? 'Saving…' : 'Set password and continue'}
        </Button>
      </Form>
      <AppToasts />
    </AuthScreen>
  );
}
