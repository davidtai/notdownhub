import { Link, NavLink } from "react-router-dom";
import { cn } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/", label: "Runs", end: true },
  { to: "/projects", label: "Projects", end: false },
  { to: "/runners", label: "Runners", end: false },
  { to: "/settings", label: "Settings", end: false },
];

/** Sticky top app bar: wordmark, surface navigation, theme control. */
export function AppBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
      {/*
        Layout: three flex children (wordmark, nav, theme control). Above sm this
        is a single row — the wordmark's sm:mr-5 restores the old gap-5 and the
        nav's sm:mr-auto pushes the toggle to the far right (unchanged desktop).
        Below sm the row wraps: wordmark + toggle share the top row (wordmark's
        mr-auto pushes the toggle right) and the nav drops to a full-width second
        row (order-last w-full), so nav and toggle can never overlap (#155). The
        nav row scrolls horizontally if links don't fit, avoiding page overflow.
      */}
      <div className="mx-auto flex max-w-[1160px] flex-wrap items-center gap-y-2 px-4 py-2 sm:h-14 sm:flex-nowrap sm:gap-y-0 sm:py-0 sm:px-6">
        <Link
          to="/"
          className="mr-auto flex shrink-0 items-center gap-2 sm:mr-5"
          aria-label="notdownhub home"
        >
          {/*
              Brand mark: a computer carried by balloons (assets/brand/logo-*.svg).
              Drawn in currentColor so it follows the theme foreground — the .dark
              class on <html> swaps --fg (text-fg) between the dark-ink and light-ink
              variants. The monitor screen is a transparent hole (evenodd).
            */}
          <svg
            viewBox="0 0 64 78"
            className="h-7 w-auto shrink-0 text-fg"
            fill="none"
            aria-hidden
          >
            <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M13.5 32 Q 16 41 21 49" />
              <path d="M32 28 L 32 49" />
              <path d="M50.5 32 Q 48 41 43 49" />
            </g>
            <g fill="currentColor">
              <ellipse cx="13.5" cy="19" rx="9.5" ry="11" />
              <path d="M11.8 29.6 L 15.2 29.6 L 13.5 32.6 Z" />
              <ellipse cx="50.5" cy="19" rx="9.5" ry="11" />
              <path d="M48.8 29.6 L 52.2 29.6 L 50.5 32.6 Z" />
              <ellipse cx="32" cy="14" rx="11" ry="12.5" />
              <path d="M30 25.8 L 34 25.8 L 32 29 Z" />
            </g>
            <g fill="currentColor">
              <path
                fillRule="evenodd"
                d="M21.5 49 h21 a3 3 0 0 1 3 3 v13 a3 3 0 0 1 -3 3 h-21 a3 3 0 0 1 -3 -3 v-13 a3 3 0 0 1 3 -3 z M23.1 51.8 h17.8 a1.6 1.6 0 0 1 1.6 1.6 v8.7 a1.6 1.6 0 0 1 -1.6 1.6 h-17.8 a1.6 1.6 0 0 1 -1.6 -1.6 v-8.7 a1.6 1.6 0 0 1 1.6 -1.6 z"
              />
              <rect x="30" y="68" width="4" height="3.6" />
              <rect x="24" y="71.4" width="16" height="3.2" rx="1.6" />
            </g>
          </svg>
          <span className="hidden text-[15px] font-semibold tracking-tight text-fg sm:inline">
            notdown<span className="text-fg-muted">hub</span>
          </span>
        </Link>

        <nav
          className="order-last flex w-full items-center gap-0.5 overflow-x-auto sm:order-none sm:mr-auto sm:w-auto sm:overflow-visible"
          aria-label="Primary"
        >
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "relative inline-flex h-12 items-center px-2.5 text-sm font-medium transition-colors sm:h-14",
                  isActive ? "text-fg" : "text-fg-muted hover:text-fg",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {n.label}
                  {isActive && (
                    <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent" />
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <ThemeToggle />
      </div>
    </header>
  );
}
