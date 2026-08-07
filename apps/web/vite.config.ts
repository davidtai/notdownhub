import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev proxies point at the developer's own test hub (the ndh front server), which serves
// the hub API under /_apis and injects auth for the Agent* routes. In production the same
// front server serves this built app, so requests are same-origin and need no proxy.
const HUB = process.env.NDH_DEV_HUB ?? "http://localhost:5959";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Consumed by `ndh hub up` (packages/cli/front.ts → uiDistDir()); gitignored.
    outDir: "../../packages/cli/ui-dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/_apis": { target: HUB, changeOrigin: true },
      "/runner": { target: HUB, changeOrigin: true },
      "/mirror": { target: HUB, changeOrigin: true },
    },
  },
});
