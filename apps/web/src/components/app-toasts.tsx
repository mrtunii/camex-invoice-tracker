import { Toast } from '@heroui/react';

/**
 * Where toasts appear. Mounted by the signed-in shell and the set-password screen, not the entry,
 * so /login doesn't download the toast code. The queue lives outside React: a toast raised just
 * before the shell mounts still shows.
 */
export function AppToasts() {
  return <Toast.Provider placement="bottom end" width={400} />;
}
