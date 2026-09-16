import type { ChatFile } from '../api/types';

/** Which preview icon/layout a file gets. */
export type FileKind = 'pdf' | 'sheet' | 'image' | 'file';

/**
 * Classifies a file for display. The stored MIME type is authoritative (it was
 * resolved from the content at upload), with the extension as a fallback for
 * files created before a status response arrives.
 */
export function fileKind(file: Pick<ChatFile, 'originalName' | 'mimeType'> & { mimeType?: string }): FileKind {
  switch (file.mimeType) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.ms-excel':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'sheet';
    case 'image/png':
    case 'image/jpeg':
      return 'image';
    default:
      break;
  }
  const name = file.originalName.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) return 'sheet';
  if (/\.(png|jpe?g)$/.test(name)) return 'image';
  return 'file';
}

export function isImageFile(file: Pick<ChatFile, 'originalName' | 'mimeType'>): boolean {
  return fileKind(file) === 'image';
}

/** «PDF» / «Excel» / «تصویر» — the label shown in tables and viewer headers. */
export function fileKindLabel(kind: FileKind): string {
  switch (kind) {
    case 'pdf':
      return 'PDF';
    case 'sheet':
      return 'Excel';
    case 'image':
      return 'تصویر';
    default:
      return 'فایل';
  }
}

/** True when the browser can render the file inside the viewer. */
export function canPreviewInline(kind: FileKind): boolean {
  return kind === 'pdf' || kind === 'image';
}
