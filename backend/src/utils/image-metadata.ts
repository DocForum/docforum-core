/**
 * Attachment content sniffing and image metadata stripping (Phase 2, issue
 * #62).
 *
 * Clinical attachments are images or PDFs. Two rules matter for PHI:
 *   1. the declared content type is never trusted — the bytes decide, and
 *      anything that is not one of the three allowed types is refused
 *      (SVG is refused on purpose: it is a script container, and an
 *      executable or archive never sniffs as an image/PDF anyway);
 *   2. image metadata is removed on upload — EXIF (including GPS) and
 *      ancillary text chunks. We parse the container formats directly rather
 *      than decode pixels, so no image codec is involved and the bytes that
 *      are kept are byte-identical to the original.
 *
 * Both functions are pure: they take a Buffer and return a Buffer.
 */

export const ALLOWED_ATTACHMENT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export type AllowedAttachmentContentType = (typeof ALLOWED_ATTACHMENT_CONTENT_TYPES)[number];

const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** The type the bytes actually are, or null when it is not an allowed
 * clinical attachment type. Never falls back to a declared type. */
export function sniffAttachmentContentType(buffer: Buffer): AllowedAttachmentContentType | null {
  if (isJpeg(buffer)) return 'image/jpeg';
  if (isPng(buffer)) return 'image/png';
  if (isPdf(buffer)) return 'application/pdf';
  return null;
}

/**
 * Removes EXIF/APPn/comment segments from a JPEG. APP0 (JFIF) is kept: it is
 * structural, not personal metadata. Everything from the Start Of Scan
 * marker onward is copied verbatim.
 */
function stripJpegMetadata(buffer: Buffer): Buffer {
  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let pos = 2;

  while (pos + 1 < buffer.length) {
    if (buffer[pos] !== 0xff) {
      // Malformed stream: keep the rest unchanged rather than corrupt it.
      chunks.push(buffer.subarray(pos));
      break;
    }
    const marker = buffer[pos + 1];
    const markerStart = pos;
    pos += 2;

    // Markers with no length payload.
    if (marker === JPEG_SOS) {
      chunks.push(buffer.subarray(markerStart));
      break;
    }
    if (marker === JPEG_EOI || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      chunks.push(buffer.subarray(markerStart, pos));
      continue;
    }

    if (pos + 2 > buffer.length) {
      chunks.push(buffer.subarray(markerStart));
      break;
    }
    const length = buffer.readUInt16BE(pos);
    if (length < 2 || pos + length > buffer.length) {
      chunks.push(buffer.subarray(markerStart));
      break;
    }
    const segmentEnd = pos + length;

    // APP1..APP15 carry EXIF/XMP/ICC/IPTC and vendor data; COM is free text.
    const isMetadataSegment = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadataSegment) {
      chunks.push(buffer.subarray(markerStart, segmentEnd));
    }
    pos = segmentEnd;
  }

  return Buffer.concat(chunks);
}

/**
 * Drops PNG chunks that can carry metadata: eXIf plus the three text chunks
 * (tEXt/iTXt/zTXt). Image data and the critical chunks are untouched. CRCs
 * are recomputed only for chunks we keep — none of the kept chunks changed.
 */
function stripPngMetadata(buffer: Buffer): Buffer {
  const chunks: Buffer[] = [buffer.subarray(0, 8)];
  let pos = 8;
  const dropped = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (end > buffer.length) {
      chunks.push(buffer.subarray(pos));
      break;
    }
    const type = buffer.subarray(pos + 4, pos + 8).toString('latin1');
    if (!dropped.has(type)) chunks.push(buffer.subarray(pos, end));
    pos = end;
  }
  if (pos < buffer.length) chunks.push(buffer.subarray(pos));

  return Buffer.concat(chunks);
}

/** Strip personal metadata for the allowed types. PDFs are returned as-is:
 * they have no EXIF, and rewriting a PDF is not worth the risk here. */
export function stripImageMetadata(buffer: Buffer, contentType: AllowedAttachmentContentType): Buffer {
  switch (contentType) {
    case 'image/jpeg':
      return isJpeg(buffer) ? stripJpegMetadata(buffer) : buffer;
    case 'image/png':
      return isPng(buffer) ? stripPngMetadata(buffer) : buffer;
    case 'application/pdf':
      return buffer;
  }
}
