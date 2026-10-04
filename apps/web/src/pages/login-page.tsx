import { type LoginRequest, loginRequestSchema } from '@camex/shared';
import { Alert, Button, Form } from '@heroui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { AuthScreen } from '@/components/auth-screen';
import { FormTextField } from '@/components/form-text-field';
import { useDocumentTitle } from '@/lib/document-title';
import { useLogin, useMe } from '@/lib/auth';

function redirectTarget(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const { from } = state;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  }
  return '/';
}

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const target = redirectTarget(location.state);
  useDocumentTitle('Sign in');

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  if (me.data) return <Navigate to={target} replace />;

  const onSubmit = form.handleSubmit((values) =>
    login.mutate(values, {
      onSuccess: () => void navigate(target, { replace: true }),
      onError: () => form.resetField('password'),
    }),
  );

  return (
    <AuthScreen
      title="Sign in"
      description="Use the account an admin created for you. There is no self sign-up."
    >
      <Form
        validationBehavior="aria"
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-4"
      >
        {login.error && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{login.error.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <FormTextField
          control={form.control}
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
        />
        <FormTextField
          control={form.control}
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
        />
        <Button type="submit" fullWidth isPending={login.isPending} className="mt-2">
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </Form>
    </AuthScreen>
  );
}
