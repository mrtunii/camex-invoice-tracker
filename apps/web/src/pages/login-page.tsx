import { type LoginRequest, loginRequestSchema } from '@camex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useLogin, useMe } from '@/lib/auth';

function redirectTarget(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const { from } = state;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  }
  return '/invoices';
}

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const target = redirectTarget(location.state);

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });
  const { errors } = form.formState;

  useEffect(() => {
    document.title = 'Sign in – Camex Invoice Tracker';
  }, []);

  if (me.data) return <Navigate to={target} replace />;

  const onSubmit = form.handleSubmit((values) =>
    login.mutate(values, {
      onSuccess: () => void navigate(target, { replace: true }),
      onError: () => form.resetField('password'),
    }),
  );

  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight">Camex</span>
          <span className="text-muted-foreground">Invoice Tracker</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>
              Use the account an admin created for you. There is no self sign-up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate onSubmit={(e) => void onSubmit(e)} className="space-y-5">
              {login.error && (
                <Alert variant="destructive">
                  <AlertDescription>{login.error.message}</AlertDescription>
                </Alert>
              )}
              <FieldGroup>
                <Field data-invalid={!!errors.email}>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    aria-invalid={!!errors.email}
                    {...form.register('email')}
                  />
                  <FieldError errors={[errors.email]} />
                </Field>
                <Field data-invalid={!!errors.password}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    aria-invalid={!!errors.password}
                    {...form.register('password')}
                  />
                  <FieldError errors={[errors.password]} />
                </Field>
              </FieldGroup>
              <Button type="submit" className="w-full" size="lg" disabled={login.isPending}>
                {login.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
