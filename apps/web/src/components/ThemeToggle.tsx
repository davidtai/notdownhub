import { Sun, Moon, MonitorSmartphone } from "lucide-react";
import { useTheme, type Theme } from "../lib/theme";
import { cn } from "../lib/utils";

const OPTIONS: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: MonitorSmartphone, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
];

/** Three-way theme control: light / system / dark. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className="flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5"
      role="radiogroup"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded transition-colors sm:h-8 sm:w-8",
              active ? "bg-surface-2 text-brand" : "text-fg-faint hover:text-fg",
            )}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
