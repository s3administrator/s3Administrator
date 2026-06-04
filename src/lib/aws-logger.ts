const noop = () => {}

/**
 * Quiet AWS SDK logger to prevent noisy internal retry warnings
 * (e.g. non-retryable streaming request) from polluting app logs.
 */
export const quietAwsLogger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

