/**
 * @deprecated Use `getObjectStorage()` from `utils/object-storage.ts` for all
 * new private-file storage. This module's `DefaultStorageProvider` returns
 * client-supplied URLs unchanged and invents non-functional
 * `storage://attachments/…` placeholders; it was replaced by real S3-
 * compatible object storage in issue #316.
 *
 * Storage interface for fulfillment attachments and lab result files.
 * See ARCHITECTURE.md §2 (File/result storage) and §6.3.4.
 */

export interface UploadAttachmentOptions {
  fileName?: string;
  contentType?: string;
  data?: Buffer | string;
  url?: string;
}

export interface StorageProvider {
  uploadAttachment(options: UploadAttachmentOptions | string): Promise<string>;
}

export class DefaultStorageProvider implements StorageProvider {
  async uploadAttachment(options: UploadAttachmentOptions | string): Promise<string> {
    if (typeof options === 'string') {
      return options;
    }
    if (options.url) {
      return options.url;
    }
    if (options.fileName) {
      return `storage://attachments/${Date.now()}-${options.fileName}`;
    }
    return `storage://attachments/${Date.now()}-attachment`;
  }
}

export const storageService: StorageProvider = new DefaultStorageProvider();
