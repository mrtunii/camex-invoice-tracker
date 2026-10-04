import { Button, toast } from '@heroui/react';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * "Vendors send invoices to <address>" with a copy button (the address is INBOX_ADDRESS).
 * `bare`: just the address and the button, for use inside a sentence.
 */
export function InboxAddress({ address, bare = false }: { address: string; bare?: boolean }) {
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
      toast.danger("Couldn't copy the address. Select it and copy it instead.");
    }
  };

  const value = (
    <span className="inline-flex items-center">
      <span className="font-medium break-all text-foreground">{address}</span>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        onPress={() => void copy()}
        aria-label={copied ? 'Address copied' : 'Copy address'}
        className="size-7"
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </span>
  );
  if (bare) return value;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-1">
      <span>Vendors send invoices to</span>
      {value}
    </span>
  );
}
