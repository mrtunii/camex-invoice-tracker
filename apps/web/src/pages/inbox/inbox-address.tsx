import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** "Vendors send invoices to <address>" with a copy button (the address is INBOX_ADDRESS). */
export function InboxAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy the address. Select it and copy it instead.");
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span>Vendors send invoices to</span>
      <span className="inline-flex items-center gap-0.5">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem] break-all text-foreground">
          {address}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            // In the empty state the address sits inside a table; keep the click to the button.
            e.stopPropagation();
            void copy();
          }}
          aria-label={copied ? 'Address copied' : 'Copy address'}
          title={copied ? 'Copied' : 'Copy address'}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </span>
    </span>
  );
}
