"use client"

import { useEffect, useRef } from "react"
import { usePathname, useSearchParams } from "next/navigation"

type TrackEvent = {
  eventType: string
  eventName: string
  path: string
  method?: string
  target?: string
  metadata?: Record<string, unknown>
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120)
}

function describeElement(element: Element): string {
  const node = element as HTMLElement
  const tag = node.tagName.toLowerCase()
  const idPart = node.id ? `#${node.id}` : ""
  const label =
    node.getAttribute("data-track") ||
    node.getAttribute("aria-label") ||
    compactText(node.textContent ?? "")

  return `${tag}${idPart}${label ? `:${label}` : ""}`.slice(0, 512)
}

function currentPath(pathname: string, searchParams: { toString(): string }): string {
  const qs = searchParams.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

export function ActionTracker({ enabled }: { enabled: boolean }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rateLimitRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!enabled) return

    const send = (events: TrackEvent[]) => {
      if (events.length === 0) return
      const payload = JSON.stringify({ events })

      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon(
          "/api/analytics/events",
          new Blob([payload], { type: "application/json" })
        )
        if (ok) return
      }

      fetch("/api/analytics/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    }

    const key = `page:${pathname}:${searchParams.toString()}`
    const now = Date.now()
    if (now - (rateLimitRef.current[key] ?? 0) > 1000) {
      rateLimitRef.current[key] = now
      send([
        {
          eventType: "page_view",
          eventName: "page_view",
          path: currentPath(pathname, searchParams),
          metadata: { referrer: document.referrer || null },
        },
      ])
    }
  }, [enabled, pathname, searchParams])

  useEffect(() => {
    if (!enabled) return

    const send = (event: TrackEvent, cooldownMs = 0) => {
      const key = `${event.eventType}:${event.eventName}:${event.path}:${event.target ?? ""}`
      const now = Date.now()

      if (cooldownMs > 0 && now - (rateLimitRef.current[key] ?? 0) < cooldownMs) {
        return
      }

      rateLimitRef.current[key] = now

      const payload = JSON.stringify({ events: [event] })
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon(
          "/api/analytics/events",
          new Blob([payload], { type: "application/json" })
        )
        if (ok) return
      }

      fetch("/api/analytics/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    }

    const onClick = (rawEvent: MouseEvent) => {
      const targetNode = rawEvent.target as Element | null
      if (!targetNode) return

      const clickable = targetNode.closest("[data-track],button,a,[role='button']")
      if (!clickable) return

      const path = currentPath(pathname, searchParams)
      const href =
        clickable instanceof HTMLAnchorElement
          ? clickable.getAttribute("href")
          : undefined

      send(
        {
          eventType: "click",
          eventName: (clickable as HTMLElement).dataset.track || "click",
          path,
          target: describeElement(clickable),
          metadata: {
            href: href ?? null,
            text: compactText((clickable as HTMLElement).textContent ?? ""),
          },
        },
        250
      )
    }

    const onSubmit = (rawEvent: SubmitEvent) => {
      const form = rawEvent.target as HTMLFormElement | null
      if (!form) return

      send(
        {
          eventType: "form_submit",
          eventName: form.getAttribute("data-track") || "form_submit",
          path: currentPath(pathname, searchParams),
          target: describeElement(form),
          method: (form.method || "POST").toUpperCase(),
        },
        250
      )
    }

    const originalFetch = window.fetch

    const wrappedFetch: typeof window.fetch = async (input, init) => {
      const startedAt = performance.now()

      try {
        const method = (
          init?.method ||
          (input instanceof Request ? input.method : "GET")
        ).toUpperCase()

        const rawUrl =
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input.url

        const parsedUrl = new URL(rawUrl, window.location.origin)
        const isInternalApi =
          parsedUrl.origin === window.location.origin &&
          parsedUrl.pathname.startsWith("/api/") &&
          parsedUrl.pathname !== "/api/analytics/events"

        if (!isInternalApi) {
          return await originalFetch(input, init)
        }

        try {
          const response = await originalFetch(input, init)
          send(
            {
              eventType: "api_call",
              eventName: `${method} ${parsedUrl.pathname}`,
              path: currentPath(pathname, searchParams),
              method,
              target: parsedUrl.pathname,
              metadata: {
                status: response.status,
                ok: response.ok,
                durationMs: Math.round(performance.now() - startedAt),
              },
            },
            500
          )
          return response
        } catch (error) {
          send(
            {
              eventType: "api_call",
              eventName: `${method} ${parsedUrl.pathname}`,
              path: currentPath(pathname, searchParams),
              method,
              target: parsedUrl.pathname,
              metadata: {
                status: 0,
                ok: false,
                durationMs: Math.round(performance.now() - startedAt),
                error:
                  error instanceof Error
                    ? error.message
                    : "request_failed",
              },
            },
            500
          )
          throw error
        }
      } catch {
        return await originalFetch(input, init)
      }
    }

    const onError = (rawEvent: ErrorEvent) => {
      send(
        {
          eventType: "error",
          eventName: "window_error",
          path: currentPath(pathname, searchParams),
          target: rawEvent.filename
            ? `${rawEvent.filename}:${rawEvent.lineno}:${rawEvent.colno}`
            : "window",
          metadata: {
            message: rawEvent.message,
          },
        },
        500
      )
    }

    const onUnhandledRejection = (rawEvent: PromiseRejectionEvent) => {
      let reason = "unhandled_rejection"
      if (rawEvent.reason instanceof Error) reason = rawEvent.reason.message
      else if (typeof rawEvent.reason === "string") reason = rawEvent.reason

      send(
        {
          eventType: "error",
          eventName: "unhandled_rejection",
          path: currentPath(pathname, searchParams),
          target: "promise",
          metadata: { reason },
        },
        500
      )
    }

    window.fetch = wrappedFetch

    document.addEventListener("click", onClick, true)
    document.addEventListener("submit", onSubmit, true)
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onUnhandledRejection)

    return () => {
      window.fetch = originalFetch
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("submit", onSubmit, true)
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onUnhandledRejection)
    }
  }, [enabled, pathname, searchParams])

  return null
}
