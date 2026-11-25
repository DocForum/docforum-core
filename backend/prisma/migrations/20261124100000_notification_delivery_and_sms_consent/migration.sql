-- Provider callbacks and consent are append/update records owned by notifications.
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed', 'bounced', 'complained');
CREATE TYPE "SmsConsentStatus" AS ENUM ('opted_in', 'opted_out');

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "destination" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NotificationDelivery_channel_status_createdAt_idx" ON "NotificationDelivery"("channel", "status", "createdAt");
CREATE INDEX "NotificationDelivery_destination_channel_idx" ON "NotificationDelivery"("destination", "channel");

CREATE TABLE "SmsConsent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "status" "SmsConsentStatus" NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SmsConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SmsConsent_userId_phone_key" ON "SmsConsent"("userId", "phone");
CREATE INDEX "SmsConsent_phone_status_idx" ON "SmsConsent"("phone", "status");
