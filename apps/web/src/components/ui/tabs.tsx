import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

/** Underline-style segmented control. Controlled — parent owns the active value. */
export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 border-b border-line", className)} role="tablist">
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={cn(
              "relative -mb-px px-3 py-2 text-sm font-medium transition-colors",
              active ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            <span className="flex items-center gap-2">
              {it.label}
              {it.count !== undefined && (
                <span className="font-mono text-[11px] text-fg-faint">{it.count}</span>
              )}
            </span>
            {active && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand" />}
          </button>
        );
      })}
    </div>
  );
}
