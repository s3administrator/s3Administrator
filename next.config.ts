import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@s3administrator/auth",
    "@s3administrator/billing",
    "@s3administrator/admin",
    "@s3administrator/audit",
    "@s3administrator/marketing",
  ],
}

export default nextConfig
