import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  // The studio is documented at http://127.0.0.1:3000; allow it in dev.
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingExcludes: {
    "/*": [
      ".git/**/*",
      ".next/**/*",
      "README.md",
      "docs/**/*",
      "next.config.ts",
      "opencode.json",
      "tests/**/*"
    ]
  }
};

export default nextConfig;
