export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return

  const { setupServerErrorLogging } = await import("./lib/system-logger")
  const { startServerMetricsCollector } = await import("./lib/server-metrics")
  setupServerErrorLogging()
  startServerMetricsCollector()
}
