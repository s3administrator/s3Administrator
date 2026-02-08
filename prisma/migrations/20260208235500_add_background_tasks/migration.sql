CREATE TABLE "BackgroundTask" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payload" JSONB NOT NULL,
  "progress" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError" TEXT,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BackgroundTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackgroundTask_userId_status_nextRunAt_idx"
ON "BackgroundTask"("userId", "status", "nextRunAt");

CREATE INDEX "BackgroundTask_createdAt_idx"
ON "BackgroundTask"("createdAt");

ALTER TABLE "BackgroundTask"
ADD CONSTRAINT "BackgroundTask_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
