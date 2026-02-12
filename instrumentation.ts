export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return

  const { setupServerErrorLogging } = await import("./src/lib/system-logger")
  const { startServerMetricsCollector } = await import("./src/lib/server-metrics")
  setupServerErrorLogging()
  startServerMetricsCollector()
}
