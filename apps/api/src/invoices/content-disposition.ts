/**
 * `inline` Content-Disposition carrying the original filename (RFC 6266): an ASCII fallback
 * for old clients plus the exact UTF-8 name in `filename*` (RFC 8187).
 */
export function inlineContentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
