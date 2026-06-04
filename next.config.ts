import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep these out of the compiled server bundle so Next's standalone tracer
  // copies them (and their native binaries) into .next/standalone/node_modules.
  // Without this, @prisma/adapter-pg was getting partially bundled and the
  // packaged server crashed with "Cannot find module '@prisma/adapter-pg'".
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "sharp"],
  // The standalone tracer otherwise drags the TypeScript compiler (~19 MB) into
  // the runtime bundle via the shiki toolchain, even though tsc is never used at
  // runtime. Exclude it so it doesn't ship in the packaged app.
  outputFileTracingExcludes: {
    "*": ["**/node_modules/typescript/**"],
  },
  experimental: {
    // Storadera (and some other S3-compatible providers) require proxy uploads
    // where multipart chunks pass through the server. Default 10 MB truncates
    // larger chunks silently.
    proxyClientMaxBodySize: "200mb",
  },
}

export default nextConfig
