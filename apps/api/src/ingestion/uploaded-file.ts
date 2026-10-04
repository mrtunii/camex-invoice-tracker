import type { IncomingFile } from './files.js';

/** The part of a multer (memory storage) file this app uses. */
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export function toIncomingFile(file: UploadedFile): IncomingFile {
  return { filename: file.originalname, contentType: file.mimetype, buffer: file.buffer };
}
