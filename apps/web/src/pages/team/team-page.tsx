import type { User } from '@camex/shared';
import { AlertDialog, Button, Table, toast } from '@heroui/react';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { TableEmpty, TablePanel } from '@/components/table-panel';
import { useCurrentUser } from '@/lib/current-user';
import { formatTimestamp } from '@/lib/format';
import { AddUserDialog } from './add-user-dialog';
import { ResetPasswordDialog } from './reset-password-dialog';
import { useUpdateUser, useUsers } from './users-query';

function DeactivateDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const updateUser = useUpdateUser();

  function deactivate() {
    if (!user) return;
    updateUser.mutate(
      { id: user.id, isActive: false },
      {
        onSuccess: () => {
          toast.success(`Deactivated ${user.name}`);
          onClose();
        },
        onError: (error) => toast.danger(error.message),
      },
    );
  }

  return (
    <AlertDialog.Backdrop isOpen={user !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>Deactivate {user?.name}?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p>
              They are signed out everywhere right away and can’t sign in until you reactivate them.
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onPress={deactivate} isPending={updateUser.isPending}>
              {updateUser.isPending ? 'Deactivating…' : 'Deactivate'}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function UserActions({
  user,
  onDeactivate,
  onResetPassword,
}: {
  user: User;
  onDeactivate: (user: User) => void;
  onResetPassword: (user: User) => void;
}) {
  const updateUser = useUpdateUser();

  function reactivate() {
    updateUser.mutate(
      { id: user.id, isActive: true },
      {
        onSuccess: () => toast.success(`Reactivated ${user.name}`),
        onError: (error) => toast.danger(error.message),
      },
    );
  }

  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" onPress={() => onResetPassword(user)}>
        Reset password
      </Button>
      {user.isActive ? (
        <Button size="sm" variant="ghost" onPress={() => onDeactivate(user)}>
          Deactivate
        </Button>
      ) : (
        <Button size="sm" variant="outline" onPress={reactivate} isPending={updateUser.isPending}>
          Reactivate
        </Button>
      )}
    </div>
  );
}

/** The team (SPEC §11 users): everyone is an admin; people are deactivated, never deleted. */
export function TeamPage() {
  const users = useUsers();
  const currentUser = useCurrentUser();
  const [deactivating, setDeactivating] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Everyone here is an admin with full access. Deactivated people can’t sign in."
        action={<AddUserDialog />}
      />

      {users.isError ? (
        <p className="text-danger">{users.error.message}</p>
      ) : (
        <TablePanel>
          <Table.Content aria-label="Team" className="min-w-[44rem]">
            <Table.Header>
              <Table.Column isRowHeader>Name</Table.Column>
              <Table.Column>Email</Table.Column>
              <Table.Column>Status</Table.Column>
              <Table.Column>Last sign-in</Table.Column>
              <Table.Column>
                <span className="sr-only">Actions</span>
              </Table.Column>
            </Table.Header>
            <Table.Body
              items={users.data ?? []}
              renderEmptyState={() => (
                <TableEmpty loading={users.isPending}>No one yet.</TableEmpty>
              )}
            >
              {(user) => {
                const isSelf = user.id === currentUser.id;
                return (
                  <Table.Row id={user.id} className={user.isActive ? undefined : 'text-muted'}>
                    <Table.Cell className="font-medium">
                      {user.name}
                      {isSelf && <span className="ml-2 font-normal text-muted">(you)</span>}
                    </Table.Cell>
                    <Table.Cell>{user.email}</Table.Cell>
                    <Table.Cell>
                      {user.isActive ? 'Active' : <span className="text-muted">Deactivated</span>}
                      {user.mustChangePassword && (
                        <span className="block text-xs text-muted">Temporary password</span>
                      )}
                    </Table.Cell>
                    <Table.Cell className="tabular whitespace-nowrap">
                      {formatTimestamp(user.lastLoginAt)}
                    </Table.Cell>
                    <Table.Cell>
                      {!isSelf && (
                        <UserActions
                          user={user}
                          onDeactivate={setDeactivating}
                          onResetPassword={setResetting}
                        />
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              }}
            </Table.Body>
          </Table.Content>
        </TablePanel>
      )}

      <DeactivateDialog user={deactivating} onClose={() => setDeactivating(null)} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}
