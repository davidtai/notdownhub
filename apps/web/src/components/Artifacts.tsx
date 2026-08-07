import { Download, Package } from "lucide-react";
import { artifactDownloadUrl, type ArtifactSummary } from "../lib/api";
import { humanSize } from "../lib/format";
import { Card } from "./ui/card";

/**
 * A run's uploaded artifacts, each with its size and a working download link. The
 * download is served by the front (local-only) straight from the hub's artifact
 * storage — the archive the CI job uploaded. Renders nothing when the run has no
 * artifacts, so a run that never called upload-artifact shows no section at all.
 */
export function Artifacts({ runId, artifacts }: { runId: number; artifacts: ArtifactSummary[] }) {
  if (artifacts.length === 0) return null;
  return (
    <Card className="mt-5 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Package size={14} className="text-fg-subtle" />
        <span className="eyebrow">Artifacts</span>
        <span className="tnum text-[11px] text-fg-subtle">{artifacts.length}</span>
      </div>
      <ul>
        {artifacts.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0">
              <span className="block truncate font-mono text-[13px] text-fg">{a.name}</span>
              <span className="tnum text-[11px] text-fg-muted">{humanSize(a.size)}</span>
            </div>
            <a
              href={artifactDownloadUrl(runId, a.name)}
              download
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-fg-muted hover:text-fg"
              aria-label={`Download ${a.name}`}
            >
              <Download size={13} />
              Download
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
