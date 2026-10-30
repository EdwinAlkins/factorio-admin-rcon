import { createRequire } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-plugin-react (pulled in by eslint-config-next) detects the React
// version by calling `context.getFilename()`, removed in ESLint 10 — the
// detection crashes before any file is linted. Reading the version from the
// installed react package skips that code path entirely.
const reactVersion = createRequire(import.meta.url)("react/package.json").version;

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: { react: { version: reactVersion } },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runtime folders of the stack (game files, archives): no source there,
    // and owned by the Factorio uid once the stack has run, so unreadable.
    "data/",
    "backups/",
  ]),
]);

export default eslintConfig;
