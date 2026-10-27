import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/*": ["./scripts/optimize.py", "./scripts/inspect_upload.py"],
  },
  serverExternalPackages: ["pg"],
  experimental: { cpus: 2 },
};
export default config;
