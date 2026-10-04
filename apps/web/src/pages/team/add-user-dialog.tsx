import { type CreateUserRequest, createUserRequestSchema, userSchema } from '@camex/shared';
import { Button, Form, Modal, toast } from '@heroui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { FormTextField } from '@/components/form-text-field';
import { ApiError, api } from '@/lib/api';
import { usersQueryKey } from './users-query';

export function AddUserDialog() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const form = useForm<CreateUserRequest>({
    resolver: zodResolver(createUserRequestSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

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
        toast.danger(error.message);
      }
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset();
    setOpen(next);
  }

  return (
    <>
      <Button onPress={() => setOpen(true)}>
        <UserPlus aria-hidden />
        Add person
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={handleOpenChange}>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Form
              validationBehavior="aria"
              onSubmit={(e) => void form.handleSubmit((values) => createUser.mutate(values))(e)}
            >
              <Modal.Header>
                <Modal.Heading>Add person</Modal.Heading>
                <p className="text-muted">Everyone on the team is an admin with full access.</p>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 py-4">
                <FormTextField control={form.control} name="name" label="Name" autoComplete="off" />
                <FormTextField
                  control={form.control}
                  name="email"
                  label="Email"
                  type="email"
                  autoComplete="off"
                />
                <FormTextField
                  control={form.control}
                  name="password"
                  label="Initial password"
                  autoComplete="new-password"
                  mono
                  description="Share it with them directly. They choose their own at first sign-in."
                />
              </Modal.Body>
              <Modal.Footer>
                <Button type="button" variant="ghost" onPress={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" isPending={createUser.isPending}>
                  {createUser.isPending ? 'Adding…' : 'Add person'}
                </Button>
              </Modal.Footer>
            </Form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
