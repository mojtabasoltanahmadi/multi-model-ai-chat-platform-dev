import { BadRequestException } from '@nestjs/common';

/** Which processing pipeline a file goes through. */
export type FileKind = 'pdf' | 'excel' | 'image';

/** What the uploader claims vs. what the content actually is. */
export interface FileContentCheck {
  kind: FileKind;
  /** The MIME we persist (content detection wins over the client's claim). */
  resolvedMime: string;
}

/**
 * Content signatures. Deliberately hand-rolled instead of pulling a detector
 * dependency: the MVP allowlist is five formats, the checks are deterministic
 * and auditable, and it keeps the backend free of ESM-only tooling.
 *
 *   %PDF-                        → pdf
 *   89 50 4E 47 0D 0A 1A 0A      → png
 *   FF D8 FF                     → jpeg
 *   D0 CF 11 E0 A1 B1 1A E1      → OLE2 container (legacy .xls)
 *   50 4B 03 04                  → zip container (OOXML .xlsx)
 */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** OLE2/CFB headers are used by .xls — and also by .doc/.ppt. */
export function looksLikeOle2(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE2_MAGIC);
}

/**
 * A legacy .xls stores its workbook in a stream named "Workbook" (or "Book"
 * for very old files). OLE2 directory entries keep stream names as UTF-16LE,
 * so the marker is searchable in the raw bytes — which also rejects .doc/.ppt
 * uploads that merely share the container format.
 */
function containsWorkbookStream(buffer: Buffer): boolean {
  return (
    buffer.includes(Buffer.from('W\0o\0r\0k\0b\0o\0o\0k', 'latin1')) ||
    buffer.includes(Buffer.from('B\0o\0o\0k', 'latin1'))
  );
}

/** True only for zip containers that actually look like an OOXML workbook. */
function looksLikeXlsx(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, 4).equals(ZIP_MAGIC) &&
    buffer.includes(Buffer.from('[Content_Types].xml', 'latin1')) &&
    buffer.includes(Buffer.from('xl/', 'latin1'))
  );
}

/** A claimed type is one of the three MVP families. */
export function isAllowedDeclaredMime(mime: string): boolean {
  return familyOfMime(mime) !== null;
}

/** The three families each map to exactly one extraction pipeline. */
export function familyOfMime(mime: string): FileKind | null {
  switch (mime) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.ms-excel':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'excel';
    case 'image/png':
    case 'image/jpeg':
      return 'image';
    default:
      return null;
  }
}

/**
 * Extension classification. Returns null when the name carries no extension
 * (the content then decides) and `'unsupported'` for extensions outside the
 * MVP allowlist.
 */
export function familyOfExtension(name: string): FileKind | 'unsupported' | null {
  const match = /\.([a-z0-9]+)\s*$/i.exec(name.trim());
  if (!match) return null;
  switch (match[1].toLowerCase()) {
    case 'pdf':
      return 'pdf';
    case 'xls':
    case 'xlsx':
      return 'excel';
    case 'png':
    case 'jpg':
    case 'jpeg':
      return 'image';
    default:
      return 'unsupported';
  }
}

/**
 * Content sniffing. Returns null when the bytes match none of the supported
 * formats, so unknown content is rejected instead of guessed.
 */
export function detectContentKind(buffer: Buffer): FileContentCheck | null {
  if (buffer.length === 0) return null;

  const head = buffer.subarray(0, 8);
  if (head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { kind: 'pdf', resolvedMime: 'application/pdf' };
  }
  if (head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { kind: 'image', resolvedMime: 'image/png' };
  }
  if (head.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return { kind: 'image', resolvedMime: 'image/jpeg' };
  }
  if (looksLikeOle2(buffer)) {
    // OLE2 but not a workbook → unsupported (e.g. a Word document).
    return containsWorkbookStream(buffer)
      ? { kind: 'excel', resolvedMime: 'application/vnd.ms-excel' }
      : null;
  }
  if (looksLikeXlsx(buffer)) {
    return {
      kind: 'excel',
      resolvedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  return null;
}

/**
 * Whitespace-only names resolve to a display fallback; the storage key is
 * always server-generated, so the display name is purely cosmetic. Path
 * separators and control characters are stripped, length is hard-capped.
 */
export function sanitizeOriginalName(rawName: string): string {
  const base = rawName
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/[\x00-\x1f\x7f]/g, '');
  const trimmed = base.trim();
  if (!trimmed) return 'بدون‌نام';
  return trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed;
}

export interface ValidateFileOptions {
  declaredMime: string;
  originalName: string;
  size: number;
  maxFileSizeBytes: number;
  /** The upload bytes (only a small head is inspected, but xlsx needs a scan). */
  buffer: Buffer;
}

/**
 * Full upload validation:
 *   1. non-empty and within the size limit
 *   2. declared MIME belongs to the MVP families
 *   3. content is a supported format AND agrees with the declared family
 *   4. the extension (when present) agrees too — never trusted, but an
 *      obvious mismatch is rejected
 * Returns the resolved kind + canonical MIME to persist.
 */
export function validateUploadedFile(options: ValidateFileOptions): FileContentCheck {
  const { declaredMime, originalName, size, maxFileSizeBytes, buffer } = options;

  if (!Number.isFinite(size) || size <= 0) {
    throw new BadRequestException('فایل خالی است و قابل قبول نیست.');
  }
  if (size > maxFileSizeBytes) {
    throw new BadRequestException(
      `حجم فایل بیش از حد مجاز است (حداکثر ${Math.floor(maxFileSizeBytes / (1024 * 1024))} مگابایت).`,
    );
  }
  if (!isAllowedDeclaredMime(declaredMime)) {
    throw new BadRequestException('نوع فایل پشتیبانی نمی‌شود. فقط PDF، Excel و تصویر مجاز است.');
  }

  const detected = detectContentKind(buffer);
  if (!detected) {
    throw new BadRequestException('محتوای فایل قابل تشخیص نیست یا از نوع پشتیبانی‌شده نیست.');
  }
  if (familyOfMime(declaredMime) !== detected.kind) {
    throw new BadRequestException('نوع اعلام‌شده فایل با محتوای آن مطابقت ندارد.');
  }

  const extensionFamily = familyOfExtension(originalName);
  if (extensionFamily === 'unsupported') {
    throw new BadRequestException('پسوند فایل پشتیبانی نمی‌شود. فقط PDF، Excel و تصویر مجاز است.');
  }
  if (extensionFamily && extensionFamily !== detected.kind) {
    throw new BadRequestException('پسوند فایل با محتوای آن مطابقت ندارد.');
  }

  return detected;
}
