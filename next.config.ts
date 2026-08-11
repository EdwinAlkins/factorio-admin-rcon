import type { NextConfig } from "next";

/**
 * CSP volontairement pragmatique : Next injecte des scripts inline pour
 * l'hydratation, d'où `'unsafe-inline'` sur script-src. Le reste verrouille
 * l'essentiel (pas de ressource externe, pas d'iframe, pas de formulaire
 * sortant), ce qui limite fortement l'impact d'une éventuelle injection.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  // Ignoré par les navigateurs en HTTP, actif dès que le panneau est servi en HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Produit .next/standalone : l'image Docker n'embarque que le strict nécessaire.
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
