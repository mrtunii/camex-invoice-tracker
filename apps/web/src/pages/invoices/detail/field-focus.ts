// Each field of the review form (and each fact of the read-only view) has a wrapper with a
// stable id, so an issue ("Due date is missing") can scroll to it and focus it.

/** DOM id of a field's wrapper: `amountDue` → `field-amountDue`, `lineItems.1.amount` → `field-lineItems-1-amount`. */
export function fieldDomId(path: string): string {
  return `field-${path.replaceAll('.', '-')}`;
}

/** Scrolls to a field and focuses its first input (inputs, date segments, select buttons). */
export function focusField(path: string): void {
  const wrapper = document.getElementById(fieldDomId(path));
  if (!wrapper) return;
  wrapper.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const target = wrapper.querySelector<HTMLElement>(
    'input:not([type=hidden]), textarea, [role="spinbutton"], button, [tabindex="0"]',
  );
  (target ?? wrapper).focus({ preventScroll: true });
}
