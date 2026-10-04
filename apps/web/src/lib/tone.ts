import type { Tone } from './format';

/** Text colour by urgency: red = act now, amber = act soon, otherwise the surrounding ink. */
export function toneClass(tone: Tone): string | undefined {
  if (tone === 'warning') return 'text-danger';
  if (tone === 'caution') return 'text-caution';
  return undefined;
}
