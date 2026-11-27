-- CreateEnum
CREATE TYPE "FulfillmentRejectionReason" AS ENUM ('unspecified', 'out_of_stock', 'expired_stock', 'facility_capacity', 'no_staff_available', 'facility_closure', 'other');

-- CreateEnum
CREATE TYPE "FulfillmentUnfulfilledReason" AS ENUM ('unspecified', 'out_of_stock', 'expired_stock', 'item_not_stocked', 'item_discontinued', 'partial_stock', 'other');

-- AlterTable
ALTER TABLE "FulfillmentRecord" ADD COLUMN     "rejectionNote" VARCHAR(500),
ADD COLUMN     "rejectionReason" "FulfillmentRejectionReason";

-- AlterTable
ALTER TABLE "FulfillmentItem" ADD COLUMN     "unfulfilledNote" VARCHAR(500),
ADD COLUMN     "unfulfilledReason" "FulfillmentUnfulfilledReason";
