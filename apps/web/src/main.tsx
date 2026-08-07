import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Self-hosted fonts (no CDN — CSP font-src is 'self'). @fontsource bundles the
// woff2 locally; Vite emits them to /assets. Weights match the design's use of
// Inter/JetBrains Mono at 400/500/600/700 (the old Google Fonts wght@ set).
// latin subset only — a CI tool's UI does not need cyrillic/greek/vietnamese font files
// (keeps the published tarball small; missing glyphs fall back to a system font).
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
