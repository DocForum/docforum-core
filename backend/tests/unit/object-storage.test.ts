// Object storage wrapper (Phase 5, issue #16 — docs/adr/0014). The S3 driver
// is exercised against a fake client: what matters here is what it *sends*
// (bucket, server-side encryption, no ACL) and how it maps a missing object.
import { describe, expect, it } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { MemoryObjectStorage, S3ObjectStorage } from '../../src/utils/object-storage';

function fakeClient(respond: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return respond(command);
    },
  } as unknown as S3Client;
  return { client, sent };
}

describe('S3ObjectStorage', () => {
  it('uploads to the configured bucket with server-side encryption and no ACL', async () => {
    const { client, sent } = fakeClient(() => ({}));
    const storage = new S3ObjectStorage(client, 'docforum-lab-results');
    await storage.putObject({ key: 'lab-results/abc', body: Buffer.from('%PDF-'), contentType: 'application/pdf' });

    expect(sent).toHaveLength(1);
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'docforum-lab-results',
      Key: 'lab-results/abc',
      ContentType: 'application/pdf',
      ContentLength: 5,
      ServerSideEncryption: 'AES256',
    });
    expect(command.input.ACL).toBeUndefined();
  });

  it('reads an object back as a Buffer', async () => {
    const { client, sent } = fakeClient(() => ({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      ContentType: 'image/png',
    }));
    const stored = await new S3ObjectStorage(client, 'bucket').getObject('lab-results/abc');
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
    expect(stored).toEqual({ body: Buffer.from([1, 2, 3]), contentType: 'image/png' });
  });

  it('maps NoSuchKey to null and rethrows anything else', async () => {
    const missing = fakeClient(() => {
      throw new NoSuchKey({ message: 'missing', $metadata: {} });
    });
    expect(await new S3ObjectStorage(missing.client, 'bucket').getObject('nope')).toBeNull();

    const failing = fakeClient(() => {
      throw new Error('network down');
    });
    await expect(new S3ObjectStorage(failing.client, 'bucket').getObject('x')).rejects.toThrow('network down');
  });

  it('deletes by key', async () => {
    const { client, sent } = fakeClient(() => ({}));
    await new S3ObjectStorage(client, 'bucket').deleteObject('lab-results/abc');
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((sent[0] as DeleteObjectCommand).input).toEqual({ Bucket: 'bucket', Key: 'lab-results/abc' });
  });
});

describe('MemoryObjectStorage', () => {
  it('round-trips, copies the buffer, and forgets on delete', async () => {
    const storage = new MemoryObjectStorage();
    const body = Buffer.from('abc');
    await storage.putObject({ key: 'k', body, contentType: 'application/pdf' });
    body[0] = 0x7a;
    expect((await storage.getObject('k'))?.body.toString()).toBe('abc');
    await storage.deleteObject('k');
    expect(await storage.getObject('k')).toBeNull();
  });
});
