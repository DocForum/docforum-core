import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
  sniffAttachmentContentType,
  stripImageMetadata,
} from '../../src/utils/image-metadata';

/** Builds a minimal JPEG: SOI, APP0 (kept), APP1/EXIF (dropped), COM
 * (dropped), DQT (kept), SOS + scan data, EOI. The bytes are not a decodable
 * picture — the stripper only walks markers, which is exactly the property
 * these tests cover. */
function jpegWithExif(): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x04]),
    Buffer.from([0x00, 0x00]),
  ]);
  const exifPayload = Buffer.from('Exif\0\0GPSLatitude=51.5', 'latin1');
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([0x00, exifPayload.length + 2]),
    exifPayload,
  ]);
  const commentPayload = Buffer.from('private note', 'latin1');
  const comment = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0x00, commentPayload.length + 2]),
    commentPayload,
  ]);
  const dqt = Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, comment, dqt, sos, eoi]);
}

function pngWithChunks(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    signature,
    chunk('IHDR', Buffer.alloc(13)),
    chunk('eXIf', Buffer.from('GPSLatitude=51.5')),
    chunk('tEXt', Buffer.from('Comment\0private')),
    chunk('IDAT', Buffer.from([0x01, 0x02, 0x03])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('attachment content sniffing', () => {
  it('detects the three allowed types from bytes', () => {
    expect(sniffAttachmentContentType(jpegWithExif())).toBe('image/jpeg');
    expect(sniffAttachmentContentType(pngWithChunks())).toBe('image/png');
    expect(sniffAttachmentContentType(Buffer.from('%PDF-1.7\nbody'))).toBe('application/pdf');
  });

  it('refuses everything else, including SVG and executables', () => {
    expect(sniffAttachmentContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffAttachmentContentType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    expect(sniffAttachmentContentType(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
    expect(sniffAttachmentContentType(Buffer.from('plain text'))).toBeNull();
    expect(ALLOWED_ATTACHMENT_CONTENT_TYPES).not.toContain('image/svg+xml');
  });
});

describe('image metadata stripping', () => {
  it('removes JPEG EXIF and comments while keeping structural markers', () => {
    const input = jpegWithExif();
    const output = stripImageMetadata(input, 'image/jpeg');

    expect(output.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(output.includes(Buffer.from('private note'))).toBe(false);
    // APP0, DQT and the scan data survive; SOI/EOI framing is intact.
    expect(output.includes(Buffer.from([0xff, 0xe0]))).toBe(true);
    expect(output.includes(Buffer.from([0xff, 0xdb]))).toBe(true);
    expect(output.includes(Buffer.from([0x11, 0x22]))).toBe(true);
    expect(output.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(output.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('removes PNG eXIf and text chunks while keeping image data', () => {
    const input = pngWithChunks();
    const output = stripImageMetadata(input, 'image/png');

    expect(output.includes(Buffer.from('eXIf'))).toBe(false);
    expect(output.includes(Buffer.from('tEXt'))).toBe(false);
    expect(output.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(output.includes(Buffer.from('IDAT'))).toBe(true);
    expect(output.includes(Buffer.from('IEND'))).toBe(true);
  });

  it('returns PDFs unchanged', () => {
    const pdf = Buffer.from('%PDF-1.7\nbody');
    expect(stripImageMetadata(pdf, 'application/pdf')).toEqual(pdf);
  });
});
