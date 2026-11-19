/** Object storage driver for lab result files (Phase 5, issue #16 —
 * docs/adr/0014). `s3` talks to a private S3 bucket (or any S3-compatible
 * endpoint); `memory` is a process-local map for tests only and is refused in
 * production. Unset with no bucket configured = `none`: the server still
 * starts (the Render preview has no bucket), and the result endpoints answer
 * 503 instead of pretending to store anything. */
function parseObjectStorageDriver(
  raw: string | undefined,
  bucket: string | undefined,
  isProduction: boolean,
): 's3' | 'memory' | 'none' {
  const driver = raw && raw !== '' ? raw : bucket ? 's3' : 'none';
  if (driver !== 's3' && driver !== 'memory' && driver !== 'none') {
    throw new Error('OBJECT_STORAGE_DRIVER must be one of "s3", "memory" or "none".');
  }
  if (driver === 'memory' && isProduction) {
    throw new Error('OBJECT_STORAGE_DRIVER=memory is for tests only and is refused in production.');
  }
  if (driver === 's3' && !bucket) {
    throw new Error('OBJECT_STORAGE_DRIVER=s3 requires OBJECT_STORAGE_BUCKET.');
  }
  return driver;
}

// Lab result files (Phase 5, issue #16 — docs/adr/0014). The bucket must be
// private: files are only ever served back through the API, which checks
// access on every read. Credentials come from the AWS SDK's default chain
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an instance role) — never
// from this object.
export const objectStorage = {
  driver: parseObjectStorageDriver(
    process.env.OBJECT_STORAGE_DRIVER,
    process.env.OBJECT_STORAGE_BUCKET,
    process.env.NODE_ENV === 'production',
  ),
  bucket: process.env.OBJECT_STORAGE_BUCKET ?? '',
  region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
  // Only for S3-compatible providers / local MinIO; unset = AWS S3.
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
  forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
} as const;
