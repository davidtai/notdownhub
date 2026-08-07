import { useEffect, useMemo, useState } from "react";
import { Check, Copy, KeyRound, Lock, Plus } from "lucide-react";
import { getJoinInfo, type JoinInfoResult } from "../lib/api";
import { cn } from "../lib/utils";

type Mode = "cli" | "docker";

/** Clipboard write with an execCommand fallback for non-secure / older contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Pairing panel. Asks the hub for real join details via /api/local/join-info:
 *  - authorized (loopback / basic auth) → shows the actual host, port, and token;
 *  - local-only (403) → shows a placeholder token, where to find the real one, and
 *    how to open the hub for remote pairing.
 * The token is never guessed client-side — the hub decides whether to reveal it.
 */
export function AddRunner() {
  const [mode, setMode] = useState<Mode>("cli");
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<JoinInfoResult | null>(null);

  useEffect(() => {
    let alive = true;
    getJoinInfo().then((r) => alive && setResult(r));
    return () => {
      alive = false;
    };
  }, []);

  const authorized = result?.ok === true;
  const localOnly = result?.ok === false && (result.status === 403 || result.status === 401);

  const hubUrl = useMemo(() => {
    if (result?.ok && result.info.host) return `http://${result.info.host}:${result.info.port}`;
    if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.host}`;
    return "http://your-hub:4949";
  }, [result]);

  // Real token only when the hub returned one; otherwise a safe placeholder.
  const tokenAuthEnabled = result?.ok ? result.info.authEnabled : true;
  const token = result?.ok && result.info.token ? result.info.token : "<token>";
  const tokenFlag = tokenAuthEnabled ? `\n  --token ${token} \\` : "";

  const cli = `ndh runner join ${hubUrl} \\${tokenFlag}
  --labels self-hosted,linux,X64`;

  const dockerToken = tokenAuthEnabled ? token : "<token>";
  const docker = `docker run -d --restart unless-stopped \\
  -e NDH_HUB_URL=${hubUrl} \\
  -e NDH_TOKEN=${dockerToken} \\
  -e NDH_NAME=my-docker-runner \\
  -e NDH_LABELS=self-hosted,linux,ARM64,docker \\
  ndh-runner`;

  const command = mode === "cli" ? cli : docker;

  const copy = async () => {
    if (await copyText(command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-3.5">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Plus size={14} className="text-brand" />
          <span className="eyebrow">Add a runner</span>
        </span>
        <div className="flex gap-0.5 rounded-md border border-line p-0.5">
          {(["cli", "docker"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-[36px] rounded px-3 font-mono text-[12px] transition-colors",
                mode === m ? "bg-surface-2 text-brand" : "text-fg-faint hover:text-fg",
              )}
            >
              {m === "cli" ? "CLI" : "Docker"}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-line bg-[color-mix(in_srgb,var(--surface)_55%,var(--bg))] p-3 pr-12 font-mono text-[12px] leading-relaxed text-fg [-webkit-overflow-scrolling:touch]">
          {highlight(command)}
        </pre>
        <button
          onClick={copy}
          aria-label="Copy command"
          className="absolute right-1.5 top-1.5 inline-flex h-11 w-11 items-center justify-center rounded border border-line bg-surface text-fg-muted transition-colors hover:text-fg active:bg-surface-2"
        >
          {copied ? <Check size={15} className="text-st-success" /> : <Copy size={15} />}
        </button>
      </div>

      {/* Token provenance / access note, driven by what the hub told us. */}
      {authorized && tokenAuthEnabled ? (
        <p className="mt-2.5 flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-fg-muted">
          <KeyRound size={12} className="mt-px shrink-0 text-st-success" />
          <span>Live token for this hub. Keep it private — it authorizes new runners.</span>
        </p>
      ) : authorized && !tokenAuthEnabled ? (
        <p className="mt-2.5 flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-fg-muted">
          <KeyRound size={12} className="mt-px shrink-0 text-fg-faint" />
          <span>Open registration (hub started with --no-auth) — no token required.</span>
        </p>
      ) : localOnly ? (
        <p className="mt-2.5 flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-fg-muted">
          <Lock size={12} className="mt-px shrink-0 text-fg-faint" />
          <span>
            This hub's UI is local-only. Start it with <span className="text-fg">--basic-auth user:pass</span> to pair from another device. token:
            printed by <span className="text-fg">ndh hub up</span>, at{" "}
            <span className="text-fg">~/.notdownhub/hub/runner-token</span>.
          </span>
        </p>
      ) : (
        <p className="mt-2.5 flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-fg-muted">
          <KeyRound size={12} className="mt-px shrink-0 text-fg-faint" />
          <span>
            token: printed by <span className="text-fg">ndh hub up</span>, stored at{" "}
            <span className="text-fg">~/.notdownhub/hub/runner-token</span> on the hub machine.
          </span>
        </p>
      )}
    </div>
  );
}

// Tint the placeholder and flag/keyword tokens so the command reads clearly.
function highlight(cmd: string) {
  return cmd.split(/(<token>|--[a-z-]+|-e\b|\bNDH_[A-Z_]+)/g).map((part, i) => {
    if (part === "<token>") return <span key={i} className="text-brand">{part}</span>;
    if (part.startsWith("--") || part === "-e" || /^NDH_[A-Z_]+$/.test(part))
      return <span key={i} className="text-edge">{part}</span>;
    return <span key={i}>{part}</span>;
  });
}
