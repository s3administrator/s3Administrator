import { ImageResponse } from "next/og"
import { SITE_NAME } from "@/lib/seo"

export const alt = `${SITE_NAME} social card`
export const size = {
  width: 1200,
  height: 630,
}
export const contentType = "image/png"

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background:
            "linear-gradient(140deg, rgb(15, 23, 42) 0%, rgb(12, 74, 110) 48%, rgb(14, 116, 144) 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            fontSize: "32px",
            fontWeight: 700,
            letterSpacing: "0.04em",
          }}
        >
          <div
            style={{
              height: "40px",
              width: "40px",
              borderRadius: "10px",
              backgroundColor: "rgba(255, 255, 255, 0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "26px",
            }}
          >
            DB
          </div>
          {SITE_NAME}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: "72px",
              fontWeight: 700,
              lineHeight: 1.05,
            }}
          >
            S3 file management
            <br />
            without console friction
          </div>
          <div
            style={{
              fontSize: "34px",
              opacity: 0.9,
            }}
          >
            AWS • Hetzner • Cloudflare R2
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            fontSize: "24px",
            opacity: 0.85,
          }}
        >
          Bulk operations • Recursive delete • Secure credentials
        </div>
      </div>
    ),
    {
      ...size,
    },
  )
}
