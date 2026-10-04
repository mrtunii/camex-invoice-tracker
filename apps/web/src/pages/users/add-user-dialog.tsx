import { type CreateUserRequest, createUserRequestSchema, userSchema } from '@camex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api';
import { usersQueryKey } from './users-query';

export function AddUserDialog() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const form = useForm<CreateUserRequest>({
    resolver: zodResolver(createUserRequestSchema),
    defaultValues: { name: '', email: '', password: '' },
  });
  const { errors } = form.formState;

  const createUser = useMutation({
    mutationFn: (body: CreateUserRequest) => api('/users', userSchema, { method: 'POST', body }),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: usersQueryKey });
      toast.success(`Added ${user.name}`);
      handleOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        form.setError('email', { message: error.message });
      } else {
        toast.error(error.message);
      }
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset();
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={form.handleSubmit((values) => createUser.mutate(values))}>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>New users are admins with full access.</DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-4">
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="new-user-name">Name</FieldLabel>
              <Input
                id="new-user-name"
                autoComplete="off"
                aria-invalid={!!errors.name}
                {...form.register('name')}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="new-user-email">Email</FieldLabel>
              <Input
                id="new-user-email"
                type="email"
                autoComplete="off"
                aria-invalid={!!errors.email}
                {...form.register('email')}
              />
              <FieldError errors={[errors.email]} />
            </Field>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="new-user-password">Initial password</FieldLabel>
              <Input
                id="new-user-password"
                className="font-mono"
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={!!errors.password}
                {...form.register('password')}
              />
              <FieldDescription>
                Share it with them directly. They can change it after signing in.
              </FieldDescription>
              <FieldError errors={[errors.password]} />
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createUser.isPending}>
              {createUser.isPending ? 'Adding…' : 'Add user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
