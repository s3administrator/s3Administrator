-- Add extension tracking to file metadata
ALTER TABLE "FileMetadata"
ADD COLUMN "extension" TEXT NOT NULL DEFAULT '';

-- Backfill extension for existing indexed files (folders remain empty extension)
UPDATE "FileMetadata"
SET "extension" = CASE
  WHEN "isFolder" THEN ''
  ELSE COALESCE(
    LOWER(
      SUBSTRING(
        SPLIT_PART("key", '/', ARRAY_LENGTH(STRING_TO_ARRAY("key", '/'), 1))
        FROM '\\.([^.]+)$'
      )
    ),
    ''
  )
END;

CREATE INDEX "FileMetadata_userId_extension_idx"
ON "FileMetadata"("userId", "extension");

-- Aggregate user-level metadata by extension
CREATE TABLE "UserFileExtensionStat" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "fileCount" INTEGER NOT NULL DEFAULT 0,
  "totalSize" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserFileExtensionStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserFileExtensionStat_userId_extension_key"
ON "UserFileExtensionStat"("userId", "extension");

CREATE INDEX "UserFileExtensionStat_userId_idx"
ON "UserFileExtensionStat"("userId");

ALTER TABLE "UserFileExtensionStat"
ADD CONSTRAINT "UserFileExtensionStat_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
