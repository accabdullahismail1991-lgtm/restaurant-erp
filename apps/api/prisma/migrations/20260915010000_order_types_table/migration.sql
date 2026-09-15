-- Convert the fixed OrderChannel enum into an admin-manageable OrderType
-- table (same pattern as PaymentMethod). Existing Order.channel and
-- Promotion.channelLimit values are preserved as plain text (their enum
-- labels become the new OrderType.code values), so historical rows keep
-- working unchanged.

CREATE TABLE "OrderType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "icon" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderType_code_key" ON "OrderType"("code");

ALTER TABLE "Order" ALTER COLUMN "channel" TYPE TEXT USING "channel"::TEXT;
ALTER TABLE "Promotion" ALTER COLUMN "channelLimit" TYPE TEXT USING "channelLimit"::TEXT;

DROP TYPE "OrderChannel";

INSERT INTO "OrderType" ("id", "name", "code", "icon", "isActive") VALUES
    ('ordtype_dine_in_seed000', 'صالة', 'DINE_IN', '🍽️', true),
    ('ordtype_takeaway_seed00', 'تيك أواي', 'TAKEAWAY', '🥡', true),
    ('ordtype_drivethru_seed0', 'Drive-thru', 'DRIVE_THRU', '🚗', true),
    ('ordtype_delivery_seed00', 'توصيل خارجي', 'DELIVERY_PARTNER', '🛵', true),
    ('ordtype_brandapp_seed00', 'تطبيق العلامة', 'BRAND_APP', '📱', true);
