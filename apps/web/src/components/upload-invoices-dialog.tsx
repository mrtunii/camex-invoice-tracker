import {
  type IngestResult,
  MAX_UPLOAD_FILES,
  UPLOAD_FIELD_NAME,
  ingestResultSchema,
  uploadRejectedSchema,
} from '@camex/shared';
import { useMutation } from '@tanstack/react-query';
import { FileText, Upload, X } from 'lucide-react';
import { type DragEvent, type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ApiError, api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

interface PickedFile {
  key: string;
  file: File;
  error: string | null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Same rule as the server: declared PDF (type or .pdf name) and real PDF bytes. */
async function pdfError(file: File): Promise<string | null> {
  const declared = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!declared) return 'Not a PDF';
  const head = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer());
  return PDF_MAGIC.every((byte, i) => head[i] === byte) ? null : 'Not a valid PDF file';
}

/**
 * Manual upload of one or more invoice PDFs (POST /api/invoices/upload): drag & drop or pick,
 * per-file errors, all-or-nothing. Used on /inbox now and on the invoices list later.
 */
export function UploadInvoicesDialog({
  onUploaded,
  trigger,
}: {
  onUploaded?: (result: IngestResult) => void;
  trigger?: ReactNode;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (picked: PickedFile[]) => {
      const body = new FormData();
      for (const { file } of picked) body.append(UPLOAD_FIELD_NAME, file, file.name);
      return api('/invoices/upload', ingestResultSchema, { method: 'POST', body });
    },
    onSuccess: (result) => {
      const count = result.invoiceIds.length;
      toast.success(`Uploaded ${count} invoice${count === 1 ? '' : 's'}. Extraction has started.`);
      onUploaded?.(result);
      handleOpenChange(false);
    },
    onError: (error) => {
      const rejected =
        error instanceof ApiError && error.status === 400
          ? uploadRejectedSchema.safeParse(error.body)
          : null;
      if (rejected?.success) {
        const names = new Set(rejected.data.rejectedFiles);
        setFiles((current) =>
          current.map((f) => (names.has(f.file.name) ? { ...f, error: 'Rejected: not a PDF' } : f)),
        );
        setFormError(rejected.data.message);
      } else if (error instanceof ApiError && error.status === 413) {
        setFormError('A file is larger than the upload limit. Nothing was stored.');
      } else {
        setFormError(error.message);
      }
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      setFiles([]);
      setFormError(null);
      upload.reset();
    }
    setOpen(next);
  }

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setFormError(null);
    const added = await Promise.all(
      Array.from(list).map(async (file) => ({
        key: `${file.name}-${String(file.size)}-${String(file.lastModified)}-${crypto.randomUUID()}`,
        file,
        error: await pdfError(file),
      })),
    );
    setFiles((current) => [...current, ...added]);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  }

  const tooMany = files.length > MAX_UPLOAD_FILES;
  const hasErrors = files.some((f) => f.error !== null);
  const canUpload = files.length > 0 && !tooMany && !hasErrors && !upload.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Upload />
            Upload PDFs
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-lg"
        // A file dropped next to the drop zone must not make the browser open it.
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Upload invoices</DialogTitle>
          <DialogDescription>
            One invoice per PDF, up to {MAX_UPLOAD_FILES} at a time. They go through the same
            extraction and review as emailed invoices.
          </DialogDescription>
        </DialogHeader>

        <label
          htmlFor={inputId}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.stopPropagation();
            onDrop(e);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-input px-4 py-8 text-center transition-colors hover:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
            dragging && 'border-ring bg-muted',
          )}
        >
          <Upload className="size-6 text-muted-foreground" aria-hidden />
          <span className="font-medium">Drop PDFs here or click to choose</span>
          <span className="text-sm text-muted-foreground">PDF files only</span>
          <input
            id={inputId}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="sr-only"
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        {files.length > 0 && (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {files.map(({ key, file, error }) => (
              <li key={key} className="flex items-center gap-3 px-3 py-2 text-sm">
                <FileText
                  className={cn(
                    'size-4 shrink-0',
                    error ? 'text-destructive' : 'text-muted-foreground',
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[0.8125rem]" title={file.name}>
                    {file.name}
                  </p>
                  <p
                    className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
                  >
                    {error ?? formatBytes(file.size)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${file.name}`}
                  disabled={upload.isPending}
                  onClick={() => {
                    setFiles((current) => current.filter((f) => f.key !== key));
                  }}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {(formError ?? tooMany) && (
          <Alert variant="destructive">
            <AlertDescription>
              {tooMany
                ? `Choose at most ${MAX_UPLOAD_FILES} files (${files.length} selected).`
                : formError}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canUpload} onClick={() => upload.mutate(files)}>
            {upload.isPending
              ? 'Uploading…'
              : `Upload ${files.length > 0 ? String(files.length) : ''} ${files.length === 1 ? 'file' : 'files'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
