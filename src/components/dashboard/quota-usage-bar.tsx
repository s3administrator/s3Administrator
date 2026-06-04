import { cn } from "@/lib/utils"

interface QuotaUsageBarProps {
  label: string
  current: number
  limit: number | null
  format?: (value: number) => string
}

export function QuotaUsageBar({ label, current, limit, format }: QuotaUsageBarProps) {
  const isUnlimited = limit === null
  const pct = isUnlimited ? 0 : Math.min(100, (current / limit) * 100)

  const barColor = isUnlimited
    ? "bg-primary"
    : pct >= 95
      ? "bg-destructive"
      : pct >= 80
        ? "bg-yellow-500"
        : "bg-primary"

  const fmt = format ?? ((v: number) => v.toLocaleString("en-US"))
  const currentLabel = fmt(current)
  const limitLabel = isUnlimited ? "Unlimited" : fmt(limit)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={cn(
            "font-medium tabular-nums",
            !isUnlimited && pct >= 95 && "text-destructive",
            !isUnlimited && pct >= 80 && pct < 95 && "text-yellow-600 dark:text-yellow-400",
          )}
        >
          {currentLabel}
          <span className="text-muted-foreground font-normal"> / {limitLabel}</span>
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: isUnlimited ? "0%" : `${pct}%` }}
        />
      </div>
    </div>
  )
}
