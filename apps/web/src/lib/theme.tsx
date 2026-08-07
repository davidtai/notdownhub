import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "ndh-theme";
const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

function resolve(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && mq().matches);
}

function apply(theme: Theme) {
  const dark = resolve(theme);
  document.documentElement.classList.toggle("dark", dark);
  // Keep the mobile browser chrome color in sync with the *chosen* theme, not
  // just the OS setting (the media-based metas only track system preference).
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = dark ? "#0c1014" : "#fbfcfd";
}

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme) || "system",
  );

  useEffect(() => {
    apply(theme);
  }, [theme]);

  // Follow the OS only while in "system" mode.
  useEffect(() => {
    if (theme !== "system") return;
    const m = mq();
    const onChange = () => apply("system");
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  };

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
