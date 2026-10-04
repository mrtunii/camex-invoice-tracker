/** Business timezone (SPEC §3): timestamps are shown in Tbilisi time. */
const dateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Tbilisi',
});

export function formatTimestamp(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
