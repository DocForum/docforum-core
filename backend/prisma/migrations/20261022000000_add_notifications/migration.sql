CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms');
CREATE TYPE "NotificationStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed');
CREATE TYPE "SmsConsentStatus" AS ENUM ('opted_in', 'opted_out');

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "type" TEXT NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'queued',
  "recipient" TEXT NOT NULL,
  "subject" TEXT,
  "textBody" TEXT NOT NULL,
  "htmlBody" TEXT,
  "providerMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SmsConsent" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "status" "SmsConsentStatus" NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsConsent_phone_key" ON "SmsConsent"("phone");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_channel_status_createdAt_idx" ON "Notification"("channel", "status", "createdAt");
CREATE INDEX "Notification_providerMessageId_idx" ON "Notification"("providerMessageId");
CREATE INDEX "SmsConsent_status_idx" ON "SmsConsent"("status");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
