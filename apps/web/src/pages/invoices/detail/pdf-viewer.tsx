import { Button, Link, Spinner, Tooltip, cn, toast } from '@heroui/react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  MoveHorizontal,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { type ReactNode, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import { apiDownload } from '@/lib/api';
import { apiUrl } from '@/lib/config';
import { useElementWidth } from '@/lib/use-element-width';

// The worker is bundled by Vite (emitted as its own file) and set in this module, as react-pdf
// requires. pdf.js 6 has no eval code paths left, so there is no `isEvalSupported` to turn off.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/** The PDF comes from the API behind the session cookie (another host, same site). */
const DOCUMENT_OPTIONS = { withCredentials: true };

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
/** Padding around the page inside the scroll area (px, both sides). */
const GUTTER = 16;

function ToolButton({
  label,
  onPress,
  isDisabled,
  children,
}: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip delay={400} closeDelay={0}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={label}
        onPress={onPress}
        isDisabled={isDisabled}
      >
        {children}
      </Button>
      <Tooltip.Content placement="bottom">{label}</Tooltip.Content>
    </Tooltip>
  );
}

/**
 * The original PDF (react-pdf / pdf.js): one page at a time, fit to the width by default, with
 * page navigation, zoom, rotation (scans arrive sideways), download and open in a new tab. If it
 * can't be rendered, a plain message keeps the download.
 */
export function PdfViewer({
  invoiceId,
  fileName,
  fill,
}: {
  invoiceId: string;
  fileName: string;
  /** Fill the parent's height and scroll inside (the split view); otherwise grow with the page. */
  fill: boolean;
}) {
  const fileUrl = apiUrl(`/invoices/${invoiceId}/file`);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(scrollRef);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  /** Relative to fit width: 1 = fit. */
  const [zoom, setZoom] = useState(1);
  const [extraRotation, setExtraRotation] = useState(0);
  const [pageInfo, setPageInfo] = useState<{ width: number; height: number; rotate: number }>();
  const [failed, setFailed] = useState(false);

  const rotation = ((pageInfo?.rotate ?? 0) + extraRotation) % 360;
  const fitWidth = Math.max(width - 2 * GUTTER, 120);
  const sideways = rotation % 180 !== 0;
  const naturalWidth = pageInfo === undefined ? null : sideways ? pageInfo.height : pageInfo.width;
  const percent =
    naturalWidth === null ? null : Math.round(((fitWidth * zoom) / naturalWidth) * 100);

  function download() {
    apiDownload(`/invoices/${invoiceId}/file`).catch((error: unknown) => {
      toast.danger(error instanceof Error ? error.message : 'Download failed');
    });
  }

  const openLink = (
    <Link
      href={fileUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open the PDF in a new tab"
      className="button button--ghost button--sm button--icon-only no-underline"
    >
      <ExternalLink className="size-4" aria-hidden />
    </Link>
  );

  return (
    <section
      aria-label={`Original PDF: ${fileName}`}
      className={cn('flex min-w-0 flex-col bg-surface-secondary', fill && 'h-full')}
    >
      <div
        role="toolbar"
        aria-label="PDF controls"
        className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-line bg-surface px-2 py-1.5"
      >
        <ToolButton
          label="Previous page"
          onPress={() => setPage((p) => Math.max(1, p - 1))}
          isDisabled={page <= 1}
        >
          <ChevronLeft aria-hidden />
        </ToolButton>
        <span className="tabular min-w-20 text-center text-xs text-muted" aria-live="polite">
          {pageCount === null ? '…' : `Page ${String(page)} of ${String(pageCount)}`}
        </span>
        <ToolButton
          label="Next page"
          onPress={() => setPage((p) => Math.min(pageCount ?? 1, p + 1))}
          isDisabled={pageCount === null || page >= pageCount}
        >
          <ChevronRight aria-hidden />
        </ToolButton>

        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <ToolButton
          label="Zoom out"
          onPress={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
          isDisabled={zoom <= MIN_ZOOM}
        >
          <ZoomOut aria-hidden />
        </ToolButton>
        <span className="tabular w-12 text-center text-xs text-muted">
          {percent === null ? '' : `${String(percent)}%`}
        </span>
        <ToolButton
          label="Zoom in"
          onPress={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
          isDisabled={zoom >= MAX_ZOOM}
        >
          <ZoomIn aria-hidden />
        </ToolButton>
        <Button
          size="sm"
          variant={zoom === 1 ? 'secondary' : 'ghost'}
          onPress={() => setZoom(1)}
          aria-pressed={zoom === 1}
        >
          <MoveHorizontal aria-hidden />
          Fit width
        </Button>
        <ToolButton label="Rotate" onPress={() => setExtraRotation((r) => (r + 90) % 360)}>
          <RotateCw aria-hidden />
        </ToolButton>

        <span className="ml-auto" />
        <ToolButton label="Download" onPress={download}>
          <Download aria-hidden />
        </ToolButton>
        <Tooltip delay={400} closeDelay={0}>
          {openLink}
          <Tooltip.Content placement="bottom">Open in a new tab</Tooltip.Content>
        </Tooltip>
      </div>

      <div
        ref={scrollRef}
        className={cn('relative min-h-0 overflow-auto', fill ? 'flex-1' : 'max-h-[80svh]')}
        style={{ padding: GUTTER }}
      >
        {failed ? (
          <div className="mx-auto max-w-sm space-y-3 py-10 text-center">
            <p>Couldn’t show this PDF here.</p>
            <p className="text-muted">Download it or open it in a new tab to read it.</p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" onPress={download}>
                <Download aria-hidden />
                Download PDF
              </Button>
              <Link
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="button button--ghost button--md no-underline"
              >
                Open in a new tab
              </Link>
            </div>
          </div>
        ) : (
          width > 0 && (
            <Document
              file={fileUrl}
              options={DOCUMENT_OPTIONS}
              suspense={false}
              onLoadSuccess={({ numPages }) => {
                setPageCount(numPages);
                setPage((p) => Math.min(p, numPages));
              }}
              onLoadError={() => setFailed(true)}
              loading={<Loading />}
              error={<span />}
              className="flex justify-center"
            >
              <Page
                pageNumber={page}
                width={fitWidth}
                scale={zoom}
                rotate={rotation}
                renderAnnotationLayer={false}
                onLoadSuccess={(loaded) =>
                  setPageInfo({
                    width: loaded.originalWidth,
                    height: loaded.originalHeight,
                    rotate: loaded.rotate,
                  })
                }
                onRenderError={() => setFailed(true)}
                loading={<Loading />}
                className="w-fit border border-line shadow-sm"
              />
            </Document>
          )
        )}
      </div>
    </section>
  );
}

function Loading() {
  return (
    <div className="grid min-h-64 w-full place-items-center">
      <Spinner size="sm" color="current" className="text-muted" aria-label="Loading the PDF" />
    </div>
  );
}
