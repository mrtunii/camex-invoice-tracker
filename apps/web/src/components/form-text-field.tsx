import { Description, FieldError, Input, Label, TextField, cn } from '@heroui/react';
import type { ReactNode } from 'react';
import { type Control, Controller, type FieldPathByValue, type FieldValues } from 'react-hook-form';

/**
 * A HeroUI TextField driven by react-hook-form (a controlled input; zod resolves the errors).
 * `validationBehavior="aria"`: react-hook-form decides when the form is valid, React Aria only
 * marks the field and shows the message.
 */
export function FormTextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  type = 'text',
  autoComplete,
  autoFocus,
  mono,
  inputMode,
  placeholder,
  className,
  inputClassName,
  suffix,
}: {
  control: Control<T>;
  name: FieldPathByValue<T, string>;
  label: ReactNode;
  description?: ReactNode;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  autoFocus?: boolean;
  /** Identifiers where 0/O and 1/l matter (temporary passwords, terms). */
  mono?: boolean;
  inputMode?: 'numeric' | 'text';
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  /** Shown right of the input, e.g. a unit. */
  suffix?: ReactNode;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          name={field.name}
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          isInvalid={fieldState.invalid}
          validationBehavior="aria"
          type={type}
          autoFocus={autoFocus}
          className={cn('flex flex-col gap-1.5', className)}
        >
          <Label>{label}</Label>
          <div className="flex items-center gap-2">
            <Input
              ref={field.ref}
              autoComplete={autoComplete}
              inputMode={inputMode}
              placeholder={placeholder}
              spellCheck={mono ? false : undefined}
              className={cn('w-full', mono && 'font-mono', inputClassName)}
            />
            {suffix}
          </div>
          {description !== undefined && <Description>{description}</Description>}
          <FieldError>{fieldState.error?.message}</FieldError>
        </TextField>
      )}
    />
  );
}
