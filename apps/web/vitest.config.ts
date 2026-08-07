import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Web test harness. Mirrors the CLI's c8 gate (packages/cli/.c8rc.json): same
// 95% line/statement, 90% branch/function thresholds, enforced on `pnpm test`
// (so `pnpm -r test` in CI runs it). Only the React plugin is loaded here — the
// tailwind plugin and the app's build config live in vite.config.ts and are not
// needed to transform components under jsdom.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // CSS is a no-op under test; components are asserted by role/text, not styles.
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Count every source file, not just the ones a test happens to import, so
      // a new untested component can never slip under the gate.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "**/*.d.ts",
      ],
      reporter: ["text", "text-summary"],
      // Same numbers as the CLI gate.
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 90,
        branches: 90,
      },
    },
  },
});
