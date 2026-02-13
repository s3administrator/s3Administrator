-- DropIndex
DROP INDEX IF EXISTS "User_stripeSubscriptionId_key";

-- AlterTable
ALTER TABLE "User"
  DROP COLUMN IF EXISTS "tier",
  DROP COLUMN IF EXISTS "stripeSubscriptionId";
