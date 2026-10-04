import type { User } from '@camex/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/lib/current-user';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate {user?.name}?</DialogTitle>
          <DialogDescription>
            They are signed out everywhere right away and can't sign in until you reactivate them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={deactivate} disabled={updateUser.isPending}>
            {updateUser.isPending ? 'Deactivating…' : 'Deactivate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserRow({
  user,
  onDeactivate,
  onResetPassword,
}: {
  user: User;
  onDeactivate: (user: User) => void;
  onResetPassword: (user: User) => void;
}) {
  const currentUser = useCurrentUser();
  const updateUser = useUpdateUser();
  const isSelf = user.id === currentUser.id;

  function reactivate() {
    updateUser.mutate(
      { id: user.id, isActive: true },
      {
        onSuccess: () => toast.success(`Reactivated ${user.name}`),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <TableRow className={user.isActive ? undefined : 'text-muted-foreground'}>
      <TableCell className="font-medium">
        {user.name}
        {isSelf && <span className="ml-2 font-normal text-muted-foreground">(you)</span>}
      </TableCell>
      <TableCell className="font-mono text-[0.8125rem]">{user.email}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          {user.isActive ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline">Deactivated</Badge>
          )}
          {user.mustChangePassword && <Badge variant="outline">Temporary password</Badge>}
        </div>
      </TableCell>
      <TableCell>{formatTimestamp(user.lastLoginAt)}</TableCell>
      <TableCell className="text-right">
        {isSelf ? null : (
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => onResetPassword(user)}>
              Reset password
            </Button>
            {user.isActive ? (
              <Button variant="ghost" size="sm" onClick={() => onDeactivate(user)}>
                Deactivate
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={reactivate}
                disabled={updateUser.isPending}
              >
                Reactivate
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function UsersPage() {
  const users = useUsers();
  const [deactivating, setDeactivating] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Everyone listed here is an admin with full access. Deactivated users can't sign in."
        actions={<AddUserDialog />}
      />

      {users.isError ? (
        <p className="text-destructive">{users.error.message}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isPending ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Loading users…
                  </TableCell>
                </TableRow>
              ) : (
                users.data.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    onDeactivate={setDeactivating}
                    onResetPassword={setResetting}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <DeactivateDialog user={deactivating} onClose={() => setDeactivating(null)} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}
