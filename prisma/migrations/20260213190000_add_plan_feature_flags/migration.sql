ALTER TABLE "Plan"
  ADD COLUMN "recursiveDelete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "multipleUpload" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "copyFolderToFolder" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "copyBucketToBucket" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "auditLogs" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "searchAllFiles" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "syncTasks" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Plan"
SET
  "bucketLimit" = 10,
  "fileLimit" = 10000,
  "features" = ARRAY[
    'Up to 10,000 cached files',
    'Up to 10 buckets',
    'Recursive delete',
    'Multiple upload'
  ]::TEXT[],
  "thumbnailCache" = false,
  "transferTasks" = false,
  "recursiveDelete" = true,
  "multipleUpload" = true,
  "copyFolderToFolder" = false,
  "copyBucketToBucket" = false,
  "auditLogs" = false,
  "searchAllFiles" = false,
  "syncTasks" = false
WHERE "slug" = 'free';

UPDATE "Plan"
SET
  "bucketLimit" = 50,
  "fileLimit" = 50000,
  "features" = ARRAY[
    'Everything in Free',
    'Preview thumbnails',
    'Copy folder to folder',
    'Copy bucket to bucket',
    'Audit logs',
    'Search all files',
    'Up to 50,000 cached files',
    'Up to 50 buckets'
  ]::TEXT[],
  "thumbnailCache" = true,
  "transferTasks" = true,
  "recursiveDelete" = true,
  "multipleUpload" = true,
  "copyFolderToFolder" = true,
  "copyBucketToBucket" = true,
  "auditLogs" = true,
  "searchAllFiles" = true,
  "syncTasks" = false
WHERE "slug" = 'starter';

UPDATE "Plan"
SET
  "bucketLimit" = 1000,
  "fileLimit" = 500000,
  "features" = ARRAY[
    'Everything in Starter',
    'Sync tasks',
    'Up to 500,000 cached files',
    'Up to 1,000 buckets'
  ]::TEXT[],
  "thumbnailCache" = true,
  "transferTasks" = true,
  "recursiveDelete" = true,
  "multipleUpload" = true,
  "copyFolderToFolder" = true,
  "copyBucketToBucket" = true,
  "auditLogs" = true,
  "searchAllFiles" = true,
  "syncTasks" = true
WHERE "slug" = 'pro';

UPDATE "Plan"
SET
  "bucketLimit" = 1000,
  "fileLimit" = 0,
  "features" = ARRAY[
    'Everything in Pro',
    'Unlimited cached files',
    'Dedicated support',
    'Custom integrations',
    'SLA'
  ]::TEXT[],
  "thumbnailCache" = true,
  "transferTasks" = true,
  "recursiveDelete" = true,
  "multipleUpload" = true,
  "copyFolderToFolder" = true,
  "copyBucketToBucket" = true,
  "auditLogs" = true,
  "searchAllFiles" = true,
  "syncTasks" = true
WHERE "slug" = 'enterprise';
