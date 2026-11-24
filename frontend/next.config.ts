import type { NextConfig } from "next";
import { readWebEnv } from "./config/env";

// The browser always talks to this app's own origin. /api/* is proxied to the
// API service, so there is no cross-origin traffic and no API URL baked into
// client code. In Kubernetes the ingress routes /api directly to the API and
// this rewrite is only a fallback. API_INTERNAL_URL is read at build time.
const { apiInternalUrl, isProduction } = readWebEnv();
const isDev = !isProduction;

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://checkout.razorpay.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://*.razorpay.com",
  "font-src 'self'",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  // Razorpay Standard Checkout renders in an iframe.
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    proxyTimeout: 60_000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
