import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { SignalRidge } from "./SignalRidge";
import { SignalDot } from "./StatusIcon";

/**
 * The instrument's power strip: wordmark + a one-line readout of hub state
 * (runners online, live runs) + theme control, over the animated signal ridge.
 */
export function Header({
  runnersOnline,
  liveRuns,
}: {
  runnersOnline?: number;
  liveRuns?: number;
}) {
  const live = (liveRuns ?? 0) > 0;
  return (
    <header className="sticky top-0 z-40 bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-5">
        <Link to="/" className="group flex items-center gap-2.5">
          <span className="relative inline-flex h-3 w-3 items-center justify-center">
            <span className="absolute h-3 w-3 rounded-full bg-brand" />
            {live && <span className="absolute h-3 w-3 rounded-full bg-brand live-pulse" />}
          </span>
          <span className="font-mono text-[15px] font-bold tracking-tight text-fg">
            notdown<span className="text-brand">hub</span>
          </span>
        </Link>

        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-4 sm:flex">
            {runnersOnline !== undefined && (
              <span className="flex items-center gap-1.5 font-mono text-xs text-fg-muted">
                <SignalDot online={runnersOnline > 0} />
                {runnersOnline} runner{runnersOnline === 1 ? "" : "s"} online
              </span>
            )}
            {liveRuns !== undefined && (
              <span className="font-mono text-xs text-fg-muted">
                <span className={live ? "text-brand" : "text-fg-faint"}>{liveRuns}</span> live
              </span>
            )}
          </div>
          <ThemeToggle />
        </div>
      </div>
      <SignalRidge live={live} />
    </header>
  );
}
