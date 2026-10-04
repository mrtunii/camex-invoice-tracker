import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { PDFDocument } from 'pdf-lib';

/** An attachment or uploaded file, held in memory. */
export interface IncomingFile {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * SPEC §4: (declared application/pdf OR named *.pdf) AND the bytes really start with `%PDF-`.
 * The extension rule covers mailers that send PDFs as application/octet-stream.
 */
export function isPdf(file: IncomingFile): boolean {
  const mime = file.contentType.split(';')[0]?.trim().toLowerCase();
  const declared = mime === 'application/pdf' || file.filename.toLowerCase().endsWith('.pdf');
  return declared && file.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Page count, or null when pdf-lib can't parse the file (it is still ingested). */
export async function countPdfPages(buffer: Buffer): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

/** Removes NUL characters, which Postgres rejects in text and jsonb. */
export function stripNul(value: string): string {
  return value.replaceAll('\u0000', '');
}

/** First `max` characters without splitting a surrogate pair. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Display name as received, minus any path, control characters and excess length. */
export function cleanFileName(name: string): string {
  const cleaned = basename(name.replaceAll('\\', '/'))
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return truncate(cleaned, 255) || 'attachment';
}
