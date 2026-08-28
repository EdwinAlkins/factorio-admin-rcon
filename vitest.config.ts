import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // next-intl ships as ESM and imports "next/server". Without inlining it,
    // Node loads it outside Vite's resolver, which then does not apply the
    // alias below and fails on that import.
    server: { deps: { inline: ["next-intl"] } },
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `next` exposes no `exports` map: next-intl's ESM build imports
      // "next/server", which Vitest's resolver cannot map to the file without
      // this explicit alias.
      "next/server": fileURLToPath(new URL("./node_modules/next/server.js", import.meta.url)),
    },
  },
});
