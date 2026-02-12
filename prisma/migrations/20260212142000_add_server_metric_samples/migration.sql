CREATE TABLE "ServerMetricSample" (
  "id" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "hostCpuPercent" DOUBLE PRECISION,
  "hostMemoryUsedBytes" BIGINT,
  "hostMemoryTotalBytes" BIGINT,
  "hostDiskUsedBytes" BIGINT,
  "hostDiskTotalBytes" BIGINT,
  "appCpuPercent" DOUBLE PRECISION,
  "appMemoryUsedBytes" BIGINT,
  "appMemoryLimitBytes" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ServerMetricSample_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServerMetricSample_recordedAt_key" ON "ServerMetricSample"("recordedAt");
CREATE INDEX "ServerMetricSample_recordedAt_idx" ON "ServerMetricSample"("recordedAt");
