-- CreateTable
CREATE TABLE "UserActionEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "method" TEXT,
    "target" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserActionEvent_createdAt_idx" ON "UserActionEvent"("createdAt");

-- CreateIndex
CREATE INDEX "UserActionEvent_userId_createdAt_idx" ON "UserActionEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserActionEvent_eventType_createdAt_idx" ON "UserActionEvent"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "UserActionEvent" ADD CONSTRAINT "UserActionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
