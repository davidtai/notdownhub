import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, FileUp, GitBranch, TriangleAlert } from "lucide-react";
import { getAgents, createProjectPlaceholder } from "../lib/api";
import {
  parseWorkflowFile,
  eventSummary,
  labelMatch,
  slugHint,
  type WorkflowFileInfo,
  type LabelMatch,
} from "../lib/workflow";
import { cn, copyText } from "../lib/utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

/*
  The #113 "Add project" wizard. The engine has no project registry, so a
  project normally exists only once it has run — this flow lets the operator
  register one FIRST, from the one artifact that defines it: the workflow YAML.

  The first step is mandatory by construction: there is no forward control on
  it at all — the only way to step 2 is a successfully parsed workflow file.
  Parsing happens client-side with the same #73 parser the Projects page uses;
  runs-on labels are checked against the live fleet (agents API) with an
  honest warning when nothing registered would pick a job up.
*/

type Step = "file" | "review" | "slug" | "done";

/** owner/repo: two non-empty, slash-free, whitespace-free halves (mirrors the hub's check). */
export function isValidSlug(slug: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(slug);
}

export function AddProject({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<Step>("file");
  const [info, setInfo] = useState<WorkflowFileInfo | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null until the fleet answers; [] is a real "no runners" answer.
  const [fleetLabels, setFleetLabels] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    getAgents()
      .then((agents) => alive && setFleetLabels([...new Set(agents.flatMap((a) => a.labels))]))
      .catch(() => alive && setFleetLabels([]));
    return () => {
      alive = false;
    };
  }, []);

  function acceptFile(file: File | undefined | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const parsed = parseWorkflowFile(text);
      if (!parsed.ok) {
        setFileError(parsed.error);
        return;
      }
      setFileError(null);
      setInfo(parsed);
      setFileName(file.name);
      setSlug((prev) => prev || slugHint(text) || "");
      setStep("review");
    };
    reader.readAsText(file);
  }

  async function create() {
    if (!info || !isValidSlug(slug) || busy) return;
    setBusy(true);
    setSubmitError(null);
    const res = await createProjectPlaceholder({
      slug,
      workflowFileName: fileName || null,
      workflowName: info.name,
      events: info.triggers.events.map(eventSummary),
      branches: info.triggers.branches,
      runsOn: info.runsOn,
    });
    setBusy(false);
    if (!res.ok) {
      setSubmitError(
        res.status === 0
          ? "Couldn't reach the hub."
          : `The hub refused the placeholder (HTTP ${res.status}).`,
      );
      return;
    }
    onCreated();
    setStep("done");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card role="dialog" aria-modal="true" aria-label="Add project" className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto p-5">
        <h2 className="text-base font-semibold text-fg">Add project</h2>
        <p className="mt-1 text-[12px] text-fg-muted">
          Registers a planned project from its workflow YAML. It appears on this page as
          &ldquo;planned&rdquo; until its first run.
        </p>

        {step === "file" && (
          <FileStep
            error={fileError}
            inputRef={inputRef}
            onFile={acceptFile}
          />
        )}

        {step === "review" && info && (
          <ReviewStep
            info={info}
            fileName={fileName}
            fleetLabels={fleetLabels}
            onBack={() => setStep("file")}
            onNext={() => setStep("slug")}
          />
        )}

        {step === "slug" && (
          <SlugStep
            slug={slug}
            setSlug={setSlug}
            busy={busy}
            error={submitError}
            onBack={() => setStep("review")}
            onCreate={create}
          />
        )}

        {step === "done" && <DoneStep slug={slug} />}

        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            {step === "done" ? "Done" : "Cancel"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * Step 1 — open the workflow YAML. Deliberately the ONLY path forward: no
 * next/skip control exists here, so the wizard cannot be completed without a
 * file that actually parses as a workflow.
 */
function FileStep({
  error,
  inputRef,
  onFile,
}: {
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement>;
  onFile: (f: File | undefined | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="mt-4">
      <div
        data-testid="workflow-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFile(e.dataTransfer?.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line px-6 py-10 text-center transition-colors",
          dragging && "border-accent bg-accent/5",
        )}
      >
        <FileUp size={22} className="text-fg-subtle" aria-hidden />
        <p className="text-[13px] font-medium text-fg">Open your workflow YAML</p>
        <p className="text-[12px] text-fg-muted">
          Drop a <code className="font-mono">.github/workflows/*.yml</code> file here, or click to browse.
          This step is required — the setup is derived from the file.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".yml,.yaml,text/yaml,application/x-yaml"
          className="hidden"
          aria-label="Workflow YAML file"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </div>
      {error && (
        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-fail/10 px-3 py-2 text-[12px] text-fail">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

const MATCH_NOTE: Record<LabelMatch, string> = {
  match: "matched by the current fleet",
  hosted: "hosted label — mapped to the self-hosted fleet by default",
  dynamic: "resolved at run time — not checked",
  none: "no runner matches",
};

/** Step 2 — what the YAML declares, with runs-on checked against the live fleet. */
function ReviewStep({
  info,
  fileName,
  fleetLabels,
  onBack,
  onNext,
}: {
  info: WorkflowFileInfo;
  fileName: string;
  fleetLabels: string[] | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const verdicts = useMemo(
    () => info.runsOn.map((label) => ({ label, verdict: fleetLabels === null ? null : labelMatch(label, fleetLabels) })),
    [info.runsOn, fleetLabels],
  );
  const misses = verdicts.filter((v) => v.verdict === "none");

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div>
        <span className="eyebrow">Workflow</span>
        <p className="mt-1 font-mono text-[13px] text-fg">
          {info.name ?? fileName} <span className="text-fg-subtle">({fileName}, {info.jobCount} {info.jobCount === 1 ? "job" : "jobs"})</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="eyebrow mr-0.5">On</span>
        {info.triggers.events.length > 0 ? (
          info.triggers.events.map((e) => (
            <Badge key={e.event} variant="outline">
              {eventSummary(e)}
            </Badge>
          ))
        ) : (
          <span className="text-[12px] text-fg-subtle">no triggers declared</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
        <span className="eyebrow mr-0.5">Branches</span>
        {info.triggers.branches.length > 0 ? (
          info.triggers.branches.map((b) => (
            <span key={b} className="inline-flex items-center gap-1 font-mono text-[11px]">
              <GitBranch size={11} className="text-fg-subtle" />
              {b}
            </span>
          ))
        ) : (
          <span className="text-[12px] text-fg-subtle">all branches</span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="eyebrow">Runs on</span>
        {verdicts.length === 0 ? (
          <span className="text-[12px] text-fg-subtle">no runs-on labels found</span>
        ) : (
          verdicts.map(({ label, verdict }) => (
            <span key={label} className="flex items-center gap-2 text-[12px]">
              <code className={cn("font-mono", verdict === "none" ? "text-fail" : "text-fg")}>{label}</code>
              <span className={cn(verdict === "none" ? "text-fail" : "text-fg-subtle")}>
                {verdict === null ? "checking the fleet…" : MATCH_NOTE[verdict]}
              </span>
            </span>
          ))
        )}
      </div>

      {misses.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-md bg-fail/10 px-3 py-2 text-[12px] text-fail">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          No runner in the current fleet matches {misses.map((m) => `'${m.label}'`).join(", ")} — jobs
          with that label will queue until one joins.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/** Step 3 — name the project (owner/repo), prefilled when the YAML hinted at it. */
function SlugStep({
  slug,
  setSlug,
  busy,
  error,
  onBack,
  onCreate,
}: {
  slug: string;
  setSlug: (s: string) => void;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: () => void;
}) {
  const valid = isValidSlug(slug);
  return (
    <div className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Project slug</span>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="owner/repo"
          autoFocus
          className="h-9 rounded-md border border-line bg-surface px-3 font-mono text-[13px] text-fg outline-none focus:border-accent"
          aria-label="Project slug (owner/repo)"
        />
      </label>
      <p className="text-[12px] text-fg-muted">
        Runs dispatched with this <code className="font-mono">owner/repo</code> slug become this
        project — the first one absorbs the placeholder.
      </p>
      {!valid && slug.length > 0 && (
        <p className="text-[12px] text-fail">The slug must be two parts: owner/repo.</p>
      )}
      {error && (
        <p className="flex items-start gap-1.5 rounded-md bg-fail/10 px-3 py-2 text-[12px] text-fail">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" onClick={onCreate} disabled={!valid || busy}>
          {busy ? "Creating…" : "Create project"}
        </Button>
      </div>
    </div>
  );
}

/** Step 4 — the placeholder is persisted; hand over the exact setup commands. */
function DoneStep({ slug }: { slug: string }) {
  const hubUrl =
    typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "http://your-hub:4949";
  const repo = slug.split("/")[1] ?? slug;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="flex items-start gap-1.5 rounded-md bg-success/10 px-3 py-2 text-[12px] text-fg">
        <Check size={14} className="mt-0.5 shrink-0 text-success" />
        <span>
          <span className="font-mono">{slug}</span> is registered as planned. Start its first run:
        </span>
      </p>
      <CommandBlock label="Dispatch from a checkout" command={`ndh dispatch --server ${hubUrl} --repository ${slug}`} />
      <CommandBlock
        label="Or trigger on push (bare git server)"
        command={`ndh hook install /srv/git/${repo}.git --server ${hubUrl} --repository ${slug}`}
      />
    </div>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <div className="relative mt-1">
        <pre className="overflow-x-auto rounded-md border border-line bg-raised p-2.5 pr-11 font-mono text-[12px] leading-relaxed text-fg">
          {command}
        </pre>
        <button
          onClick={copy}
          aria-label={`Copy: ${label}`}
          className="absolute right-1.5 top-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface text-fg-muted transition-colors hover:text-fg"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
