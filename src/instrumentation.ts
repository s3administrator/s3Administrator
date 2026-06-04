export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return
  const { setupServerErrorLogging } = await import("./lib/system-logger")
  setupServerErrorLogging()
}
