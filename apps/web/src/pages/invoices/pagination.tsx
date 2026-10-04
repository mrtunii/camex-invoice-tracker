import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

/** 1 … 4 5 [6] 7 8 … 20: the first, the last and two either side of the current page. */
function pageNumbers(page: number, pages: number): (number | 'gap')[] {
  const shown = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  const sorted = [...shown].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return sorted.flatMap((n, i) => {
    const previous = sorted[i - 1];
    return previous !== undefined && n - previous > 1 ? ['gap' as const, n] : [n];
  });
}

const linkClass =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm tabular-nums hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** "51–100 of 123" and page links (real links: they change the URL, so back/forward works). */
export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="text-muted-foreground tabular-nums">
        {total === 0
          ? 'No invoices'
          : `${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
      </p>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center gap-0.5">
          {page > 1 ? (
            <Link to={hrefFor(page - 1)} className={linkClass} aria-label="Previous page">
              <ChevronLeft className="size-4" aria-hidden />
            </Link>
          ) : (
            <span className={cn(linkClass, 'pointer-events-none opacity-40')} aria-hidden>
              <ChevronLeft className="size-4" />
            </span>
          )}
          {pageNumbers(page, pages).map((n, i) =>
            n === 'gap' ? (
              <span key={`gap-${String(i)}`} className="px-1 text-muted-foreground" aria-hidden>
                …
              </span>
            ) : (
              <Link
                key={n}
                to={hrefFor(n)}
                aria-label={`Page ${String(n)}`}
                aria-current={n === page ? 'page' : undefined}
                className={cn(
                  linkClass,
                  n === page && 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}
              >
                {n}
              </Link>
            ),
          )}
          {page < pages ? (
            <Link to={hrefFor(page + 1)} className={linkClass} aria-label="Next page">
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : (
            <span className={cn(linkClass, 'pointer-events-none opacity-40')} aria-hidden>
              <ChevronRight className="size-4" />
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
