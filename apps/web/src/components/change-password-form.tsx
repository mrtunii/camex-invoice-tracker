import type { UseFormReturn } from 'react-hook-form';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ChangePasswordValues } from '@/lib/change-password';

export function ChangePasswordFields({
  form,
  currentLabel = 'Current password',
  idPrefix = 'change-password',
}: {
  form: UseFormReturn<ChangePasswordValues>;
  currentLabel?: string;
  idPrefix?: string;
}) {
  const { errors } = form.formState;
  return (
    <FieldGroup>
      <Field data-invalid={!!errors.currentPassword}>
        <FieldLabel htmlFor={`${idPrefix}-current`}>{currentLabel}</FieldLabel>
        <Input
          id={`${idPrefix}-current`}
          type="password"
          autoComplete="current-password"
          aria-invalid={!!errors.currentPassword}
          {...form.register('currentPassword')}
        />
        <FieldError errors={[errors.currentPassword]} />
      </Field>
      <Field data-invalid={!!errors.newPassword}>
        <FieldLabel htmlFor={`${idPrefix}-new`}>New password</FieldLabel>
        <Input
          id={`${idPrefix}-new`}
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.newPassword}
          {...form.register('newPassword')}
        />
        <FieldError errors={[errors.newPassword]} />
      </Field>
      <Field data-invalid={!!errors.confirmPassword}>
        <FieldLabel htmlFor={`${idPrefix}-confirm`}>Repeat new password</FieldLabel>
        <Input
          id={`${idPrefix}-confirm`}
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.confirmPassword}
          {...form.register('confirmPassword')}
        />
        <FieldError errors={[errors.confirmPassword]} />
      </Field>
    </FieldGroup>
  );
}
