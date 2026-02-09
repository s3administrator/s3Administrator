export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { setupServerErrorLogging } = await import("./src/lib/system-logger")
  setupServerErrorLogging()
}

