import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: { "/api/*": ["./scripts/optimize.py"] },
  serverExternalPackages: ["pg"],
  experimental: { cpus: 2 },
};
export default config;
