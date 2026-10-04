import {
  type IngestResult,
  MAX_UPLOAD_FILES,
  UPLOAD_FIELD_NAME,
  ingestResultSchema,
  uploadRejectedSchema,
} from '@camex/shared';
import { Alert, Button, Modal, cn, toast } from '@heroui/react';
import { useMutation } from '@tanstack/react-query';
import { FileText, Upload, X } from 'lucide-react';
import { type DragEvent, useId, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { formatBytes, plural } from '@/lib/format';

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
 * per-file errors, all-or-nothing. The page's one primary action on Home, Invoices and Inbox.
 */
export function UploadInvoicesDialog({
  onUploaded,
}: {
  onUploaded?: (result: IngestResult) => void;
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
      toast.success(
        `Uploaded ${plural(result.invoiceIds.length, 'invoice', 'invoices')}. Reading them now.`,
      );
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
    <>
      <Button onPress={() => setOpen(true)}>
        <Upload aria-hidden />
        Upload PDFs
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={handleOpenChange}>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Upload invoices</Modal.Heading>
              <p className="text-muted">
                One invoice per PDF, up to {MAX_UPLOAD_FILES} at a time. They are read and checked
                like emailed invoices.
              </p>
            </Modal.Header>
            <Modal.Body
              className="flex flex-col gap-3 py-4"
              // A file dropped next to the drop zone must not make the browser open it.
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => e.preventDefault()}
            >
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
                  'flex cursor-pointer flex-col items-center gap-2 rounded-panel border border-dashed border-line px-4 py-8 text-center transition-colors hover:bg-surface-secondary has-[:focus-visible]:focus-ring',
                  dragging && 'border-primary bg-primary/5',
                )}
              >
                <Upload className="size-6 text-muted" aria-hidden />
                <span className="font-medium">Drop PDFs here or click to choose</span>
                <span className="text-xs text-muted">PDF files only</span>
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
                <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-panel border border-line">
                  {files.map(({ key, file, error }) => (
                    <li key={key} className="flex items-center gap-3 px-3 py-2">
                      <FileText
                        className={cn('size-4 shrink-0', error ? 'text-danger' : 'text-muted')}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate" title={file.name}>
                          {file.name}
                        </p>
                        <p className={cn('text-xs', error ? 'text-danger' : 'text-muted')}>
                          {error ?? formatBytes(file.size)}
                        </p>
                      </div>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${file.name}`}
                        isDisabled={upload.isPending}
                        onPress={() => setFiles((current) => current.filter((f) => f.key !== key))}
                      >
                        <X aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {(formError ?? tooMany) && (
                <Alert status="danger">
                  <Alert.Content>
                    <Alert.Description>
                      {tooMany
                        ? `Choose at most ${MAX_UPLOAD_FILES} files (${files.length} selected).`
                        : formError}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onPress={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                isDisabled={!canUpload}
                isPending={upload.isPending}
                onPress={() => upload.mutate(files)}
              >
                {upload.isPending
                  ? 'Uploading…'
                  : files.length > 0
                    ? `Upload ${plural(files.length, 'file', 'files')}`
                    : 'Upload'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
