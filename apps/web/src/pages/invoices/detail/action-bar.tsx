import type { InvoiceDetail } from '@camex/shared';
import { Button, Dropdown, Label, Tooltip, cn } from '@heroui/react';
import { ChevronDown } from 'lucide-react';

export interface ActionHandlers {
  onSave: () => void;
  onApprove: (andNext: boolean) => void;
  onReject: () => void;
  onReextract: () => void;
  onMarkPaid: () => void;
  onUndoPayment: () => void;
  onReopen: () => void;
}

function MoreMenu({ items }: { items: { id: string; label: string; onAction: () => void }[] }) {
  return (
    <Dropdown>
      <Button variant="ghost" aria-label="More actions">
        More
        <ChevronDown aria-hidden />
      </Button>
      <Dropdown.Popover placement="top start" className="min-w-44">
        <Dropdown.Menu
          aria-label="More actions"
          onAction={(key) => items.find((item) => item.id === key)?.onAction()}
        >
          {items.map((item) => (
            <Dropdown.Item key={item.id} id={item.id} textValue={item.label}>
              <Label>{item.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** A button that stays disabled with its reason in a tooltip (and for screen readers). */
function Blocked({ reason, children }: { reason: string | null; children: React.ReactElement }) {
  if (reason === null) return children;
  return (
    <Tooltip delay={200} closeDelay={0}>
      <Tooltip.Trigger
        aria-label={reason}
        className="rounded-control outline-none focus-visible:focus-ring"
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content placement="top" className="max-w-xs break-normal whitespace-normal">
        {reason}
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * The actions for the invoice's status (T06 §3): To review → Approve (Save & approve when edited),
 * Save, Approve & next, and Reject / Re-extract under More · To pay → Mark paid, Reopen under
 * More · Paid → Undo payment · Rejected → Reopen.
 */
export function ActionBar({
  invoice,
  dirty,
  busy,
  saving,
  missing,
  handlers,
  className,
}: {
  invoice: InvoiceDetail;
  dirty: boolean;
  /** An action is running: everything waits. */
  busy: boolean;
  saving: boolean;
  /** Why Approve can't happen yet (missing required fields, saved state), or null. */
  missing: string | null;
  handlers: ActionHandlers;
  className?: string;
}) {
  const bar = cn(
    'flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3',
    className,
  );
  // Marks the page as having a bottom action bar (toasts move above it, see index.css).
  const marker = { 'data-action-bar': '' };

  switch (invoice.status) {
    case 'processing':
      return null;
    case 'needs_review': {
      // Edits may fill what is missing; Save & approve checks again after saving.
      const blocked = dirty ? null : missing;
      return (
        <div className={bar} {...marker}>
          <MoreMenu
            items={[
              { id: 'reject', label: 'Reject…', onAction: handlers.onReject },
              { id: 'reextract', label: 'Read the PDF again…', onAction: handlers.onReextract },
            ]}
          />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {dirty && (
              <Button
                variant="outline"
                onPress={handlers.onSave}
                isPending={saving}
                isDisabled={busy}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
            <Blocked reason={blocked}>
              <Button
                variant="outline"
                onPress={() => handlers.onApprove(true)}
                isDisabled={busy || blocked !== null}
              >
                Approve & next
              </Button>
            </Blocked>
            <Blocked reason={blocked}>
              <Button
                onPress={() => handlers.onApprove(false)}
                isDisabled={busy || blocked !== null}
              >
                {dirty ? 'Save & approve' : 'Approve'}
              </Button>
            </Blocked>
          </div>
        </div>
      );
    }
    case 'unpaid':
      return (
        <div className={bar} {...marker}>
          <MoreMenu
            items={[{ id: 'reopen', label: 'Reopen for review', onAction: handlers.onReopen }]}
          />
          <Button className="ml-auto" onPress={handlers.onMarkPaid} isDisabled={busy}>
            Mark paid
          </Button>
        </div>
      );
    case 'paid':
      return (
        <div className={bar} {...marker}>
          <Button
            variant="outline"
            className="ml-auto"
            onPress={handlers.onUndoPayment}
            isDisabled={busy}
          >
            Undo payment
          </Button>
        </div>
      );
    case 'rejected':
      return (
        <div className={bar} {...marker}>
          <Button
            variant="outline"
            className="ml-auto"
            onPress={handlers.onReopen}
            isDisabled={busy}
          >
            Reopen
          </Button>
        </div>
      );
  }
}
