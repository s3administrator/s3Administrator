-- CreateTable
CREATE TABLE "MediaThumbnail" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "thumbnailBucket" TEXT,
    "thumbnailKey" TEXT,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "sourceLastModified" TIMESTAMP(3),
    "sourceSize" BIGINT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaThumbnail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaThumbnail_userId_credentialId_bucket_key_key" ON "MediaThumbnail"("userId", "credentialId", "bucket", "key");

-- CreateIndex
CREATE INDEX "MediaThumbnail_userId_status_updatedAt_idx" ON "MediaThumbnail"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "MediaThumbnail_credentialId_bucket_key_idx" ON "MediaThumbnail"("credentialId", "bucket", "key");

-- CreateIndex
CREATE INDEX "FileMetadata_gallery_filter_idx" ON "FileMetadata"("userId", "credentialId", "bucket", "key") WHERE "isFolder" = false;

-- CreateIndex
CREATE INDEX "FileMetadata_gallery_cursor_idx" ON "FileMetadata"("userId", "credentialId", "bucket", "lastModified" DESC, "id" DESC) WHERE "isFolder" = false;

-- AddForeignKey
ALTER TABLE "MediaThumbnail" ADD CONSTRAINT "MediaThumbnail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaThumbnail" ADD CONSTRAINT "MediaThumbnail_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "S3Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
