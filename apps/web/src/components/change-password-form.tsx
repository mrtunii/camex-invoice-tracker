import type { UseFormReturn } from 'react-hook-form';
import { FormTextField } from '@/components/form-text-field';
import type { ChangePasswordValues } from '@/lib/change-password';

export function ChangePasswordFields({
  form,
  currentLabel = 'Current password',
}: {
  form: UseFormReturn<ChangePasswordValues>;
  currentLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormTextField
        control={form.control}
        name="currentPassword"
        label={currentLabel}
        type="password"
        autoComplete="current-password"
      />
      <FormTextField
        control={form.control}
        name="newPassword"
        label="New password"
        type="password"
        autoComplete="new-password"
      />
      <FormTextField
        control={form.control}
        name="confirmPassword"
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
      />
    </div>
  );
}
