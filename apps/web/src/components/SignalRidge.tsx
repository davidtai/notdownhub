import { cn } from "../lib/utils";

/**
 * The signature element: an oscilloscope baseline that runs under the header.
 * It drifts (a live signal) whenever any run is active and flat-lines when the
 * fleet is idle — a literal read on whether your hub is "not down". Ambient and
 * low-contrast; motion is disabled under prefers-reduced-motion via .ridge-trace.
 */

// One tile of the trace. Two tiles are laid end to end and scrolled by 50% so
// the loop is seamless. Live = a busy wave; idle = a near-flat line with a blip.
const LIVE = "M0 20 L40 20 L48 6 L56 34 L64 20 L120 20 L128 12 L136 28 L144 20 L200 20";
const IDLE = "M0 20 L96 20 L100 16 L104 24 L108 20 L200 20";

export function SignalRidge({ live }: { live: boolean }) {
  const d = live ? LIVE : IDLE;
  return (
    <div
      className="relative h-10 w-full overflow-hidden border-b border-line"
      aria-hidden="true"
    >
      {/* faint fill under the trace */}
      <svg
        className={cn("absolute inset-0 h-full", live && "ridge-trace")}
        width="200%"
        height="100%"
        viewBox="0 0 400 40"
        preserveAspectRatio="none"
        fill="none"
      >
        {/* two tiles end to end so the scroll loops seamlessly */}
        {[0, 200].map((dx) => (
          <path
            key={dx}
            d={d}
            transform={`translate(${dx} 0)`}
            stroke="var(--brand-glow)"
            strokeWidth={live ? 1.6 : 1}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={live ? 0.55 : 0.25}
          />
        ))}
      </svg>
      {/* fade the edges into the header */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-bg via-transparent to-bg" />
    </div>
  );
}
