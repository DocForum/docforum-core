// Fulfillment proof file checks (issue #316), kept free of database imports
// so they are unit-testable. Same rules as lab results (ADR 0018): an
// allowlisted Content-Type, a size cap and leading bytes that match it.
import { config } from '../../../config';
import { HttpError } from '../../../http-error';

/** Accepted proof formats and the leading bytes each must start with. The
 * declared Content-Type alone is not trusted: the body has to match it. */
export const PROOF_FILE_SIGNATURES: Record<string, { extension: string; magic: number[] }> = {
  'application/pdf': { extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  'image/png': { extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
};

export const PROOF_CONTENT_TYPES = Object.keys(PROOF_FILE_SIGNATURES);

function normaliseContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Validates the file's declared type, size and leading bytes. Exported for
 * unit tests. Throws the HttpError the route answers with. */
export function assertAcceptableProofFile(file: { body: unknown; contentType: string | undefined }): {
  body: Buffer;
  contentType: string;
} {
  const contentType = normaliseContentType(file.contentType);
  const signature = PROOF_FILE_SIGNATURES[contentType];
  if (!signature) {
    throw new HttpError(415, `Proof files must be one of: ${PROOF_CONTENT_TYPES.join(', ')}.`, 'PROOF_UNSUPPORTED_TYPE');
  }
  if (!Buffer.isBuffer(file.body) || file.body.byteLength === 0) {
    throw new HttpError(400, 'The request body must be the proof file.', 'PROOF_EMPTY');
  }
  const body = file.body;
  if (body.byteLength > config.orders.proofMaxBytes) {
    throw new HttpError(413, `Proof files may be at most ${config.orders.proofMaxBytes} bytes.`, 'PROOF_TOO_LARGE');
  }
  if (!signature.magic.every((byte, index) => body[index] === byte)) {
    throw new HttpError(415, `The file content is not a valid ${contentType} file.`, 'PROOF_CONTENT_MISMATCH');
  }
  return { body, contentType };
}

