import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  outputFileTracingExcludes: {
    "/*": [
      ".git/**/*",
      ".next/**/*",
      "Doc.md",
      "README.md",
      "docs/**/*",
      "next.config.ts",
      "opencode.json",
      "tests/**/*"
    ]
  }
};

export default nextConfig;
