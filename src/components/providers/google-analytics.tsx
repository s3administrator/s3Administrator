"use client"

import { useEffect } from "react"
import Script from "next/script"
import { usePathname, useSearchParams } from "next/navigation"
import {
  CONSENT_BY_CHOICE,
  CONSENT_STORAGE_KEY,
  EEA_COUNTRY_CODES,
} from "@/lib/analytics-consent"

declare global {
  interface Window {
    dataLayer: unknown[]
    gtag?: (...args: unknown[]) => void
  }
}

export function GoogleAnalytics({ measurementId }: { measurementId?: string }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (!measurementId || !window.gtag) return

    const qs = searchParams.toString()
    const pagePath = qs ? `${pathname}?${qs}` : pathname

    window.gtag("event", "page_view", {
      page_path: pagePath,
      page_location: window.location.href,
      page_title: document.title,
    })
  }, [measurementId, pathname, searchParams])

  if (!measurementId) return null

  const consentAll = JSON.stringify(CONSENT_BY_CHOICE.all)
  const consentAnalytics = JSON.stringify(CONSENT_BY_CHOICE.analytics)
  const consentEssential = JSON.stringify(CONSENT_BY_CHOICE.essential)
  const eeaRegions = JSON.stringify(EEA_COUNTRY_CODES)

  return (
    <>
      <Script id="ga-consent-default" strategy="beforeInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;

          gtag('consent', 'default', ${consentAll});
          gtag('consent', 'default', Object.assign({}, ${consentEssential}, {
            region: ${eeaRegions},
            wait_for_update: 500
          }));

          try {
            var savedConsent = window.localStorage.getItem('${CONSENT_STORAGE_KEY}');
            var consentMap = {
              all: ${consentAll},
              analytics: ${consentAnalytics},
              essential: ${consentEssential}
            };
            if (savedConsent && consentMap[savedConsent]) {
              gtag('consent', 'update', consentMap[savedConsent]);
            }
          } catch (e) {}
        `}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};
          window.gtag('js', new Date());
          window.gtag('config', '${measurementId}', { send_page_view: false });
        `}
      </Script>
    </>
  )
}
