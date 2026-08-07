// Pre-paint theme boot. Applies the persisted theme to <html> before the app
// renders, so the page never flashes the wrong palette. This lived as an inline
// <script> in index.html, but the front now sends a strict CSP whose
// `script-src 'self'` forbids inline scripts — so it ships as its own module,
// served from /assets and referenced by index.html's <head>. ThemeProvider
// re-applies the same choice reactively once React mounts; this only covers the
// gap before that.
export function applyStoredTheme(): void {
  try {
    const t = localStorage.getItem("ndh-theme") || "system";
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    // localStorage or matchMedia unavailable — leave the stylesheet default in place.
  }
}

applyStoredTheme();
