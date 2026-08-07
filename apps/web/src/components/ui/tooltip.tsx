import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Minimal hover/focus tooltip — no portal, positioned with CSS. Good enough for
 * short glossary hints (status names, timestamps) without pulling in a popover lib.
 */
export function Tooltip({
  label,
  children,
  side = "top",
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded border border-line-strong bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg shadow-lg",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            className,
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
