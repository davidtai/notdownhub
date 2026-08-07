import { Link, NavLink } from "react-router-dom";
import { cn } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/", label: "Runs", end: true },
  { to: "/runners", label: "Runners", end: false },
  { to: "/settings", label: "Settings", end: false },
];

/** Sticky top app bar: wordmark, surface navigation, theme control. */
export function AppBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1160px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-5">
          <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="notdownhub home">
            <span
              className="grid h-6 w-6 place-items-center rounded-md bg-accent text-white"
              aria-hidden
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12.5l5 5 11-11" />
              </svg>
            </span>
            <span className="hidden text-[15px] font-semibold tracking-tight text-fg sm:inline">
              notdown<span className="text-fg-muted">hub</span>
            </span>
          </Link>

          <nav className="flex items-center gap-0.5" aria-label="Primary">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    "relative inline-flex h-14 items-center px-2.5 text-sm font-medium transition-colors",
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
        </div>

        <ThemeToggle />
      </div>
    </header>
  );
}
