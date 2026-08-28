import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The pages' CSP is NOT here: it carries a nonce per request and therefore
 * lives in `src/proxy.ts`. Adding a second one here would send two headers,
 * which the browser combines — needlessly hard to read back.
 *
 * API routes never render HTML: nothing to load, so everything is refused.
 */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  // Ignored by browsers over HTTP, active as soon as the panel is served over HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/**
 * Hosts allowed to load `next dev` resources (HMR included).
 *
 * Next refuses them outside localhost by default. Opening the panel from
 * another machine on the network — a phone, a test box — therefore breaks hot
 * reload without the browser saying so.
 *
 * Driven by a variable rather than hard-coded: the address depends on the
 * machine, and this list makes no sense in production.
 */
const devOrigins = (process.env.NEXT_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Produces .next/standalone: the Docker image ships only what is needed.
  output: "standalone",
  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }] },
    ];
  },
};

export default withNextIntl(nextConfig);
