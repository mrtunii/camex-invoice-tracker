import { useEffect } from 'react';

/** The browser tab reads "<title> – Camex Invoices". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} – Camex Invoices`;
  }, [title]);
}
