export const MIN_TASK_SCHEDULE_INTERVAL_SECONDS = 60 * 60
const MAX_TASK_CRON_LENGTH = 120
export const TASK_SCHEDULES_DISABLED_MESSAGE = "Task schedules are temporarily disabled"

export interface TaskSchedulePayload {
  cron: string
}

export interface ResolvedTaskSchedule {
  enabled: boolean
  cron: string | null
  legacyIntervalSeconds: number | null
}

export class TaskScheduleValidationError extends Error {}

function formatIntervalLabel(seconds: number): string {
  const normalized = Math.max(1, Math.floor(seconds))
  if (normalized % 3600 === 0) {
    const hours = normalized / 3600
    return hours === 1 ? "1 hour" : `${hours} hours`
  }
  if (normalized % 60 === 0) {
    const minutes = normalized / 60
    return minutes === 1 ? "1 minute" : `${minutes} minutes`
  }
  return normalized === 1 ? "1 second" : `${normalized} seconds`
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

export function normalizeTaskScheduleCron(raw: string): string {
  const normalized = normalizeWhitespace(raw)
  if (!normalized) {
    throw new TaskScheduleValidationError("Schedule cron is required")
  }
  if (normalized.length > MAX_TASK_CRON_LENGTH) {
    throw new TaskScheduleValidationError("Schedule cron is too long")
  }
  return normalized
}

export function assertValidTaskScheduleCron(
  raw: string,
  minIntervalSeconds = MIN_TASK_SCHEDULE_INTERVAL_SECONDS
): string {
  normalizeTaskScheduleCron(raw)

  if (minIntervalSeconds < MIN_TASK_SCHEDULE_INTERVAL_SECONDS) {
    throw new TaskScheduleValidationError(
      `Schedule is too frequent. Minimum interval is ${formatIntervalLabel(MIN_TASK_SCHEDULE_INTERVAL_SECONDS)}`
    )
  }

  throw new TaskScheduleValidationError(TASK_SCHEDULES_DISABLED_MESSAGE)
}

export function nextRunAtFromCron(_cron: string, _from: Date): Date {
  return new Date(_from.getTime())
}

export function getUpcomingRunDatesFromCron(
  _cron: string,
  _nextRunAt: Date,
  _count = 3
): string[] {
  return []
}

export function resolveTaskSchedule(schedule: {
  isRecurring: boolean
  scheduleCron?: string | null
  scheduleIntervalSeconds?: number | null
}): ResolvedTaskSchedule {
  void schedule
  return {
    enabled: false,
    cron: null,
    legacyIntervalSeconds: null,
  }
}

export function nextRunAtForTaskSchedule(
  _schedule: ResolvedTaskSchedule,
  _from: Date
): Date | null {
  return null
}

export function getEffectiveNextRunAtForTask(params: {
  isRecurring: boolean
  scheduleCron?: string | null
  scheduleIntervalSeconds?: number | null
  nextRunAt: Date
}, _now: Date = new Date()): Date {
  return params.nextRunAt
}
