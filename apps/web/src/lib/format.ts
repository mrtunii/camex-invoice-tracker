/** Business timezone (SPEC §3): timestamps are shown in Tbilisi time. */
const dateTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Tbilisi',
});

export function formatTimestamp(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}
