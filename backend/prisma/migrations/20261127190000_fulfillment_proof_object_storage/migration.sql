-- Issue #316: fulfillment proof files move to private object storage.
-- The old column held client-supplied URLs (or invented storage://
-- placeholders). Keep that data, renamed so every reader sees it is legacy
-- and untrusted; new uploads use the server-generated object key below.
ALTER TABLE "FulfillmentProof" RENAME COLUMN "attachmentUrl" TO "legacyAttachmentUrl";

ALTER TABLE "FulfillmentProof" ADD COLUMN     "attachmentByteSize" INTEGER,
ADD COLUMN     "attachmentContentType" TEXT,
ADD COLUMN     "attachmentObjectKey" TEXT;
