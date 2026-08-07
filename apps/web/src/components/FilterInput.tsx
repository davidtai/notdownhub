import { Search } from "lucide-react";
import {
  TagsInput,
  TagsInputClear,
  TagsInputInput,
  TagsInputItem,
  TagsInputLabel,
  TagsInputList,
} from "./ui/tags-input";

/*
  The saved-filter input for the Runs and Runners lists. Built on the shadcn
  tags-input primitive (src/components/ui/tags-input.tsx): typing filters live via
  `draft`; pressing Enter commits the query as a removable pill in `pills`. Pills
  combine with AND (see lib/filter). Both are controlled by the page, which
  persists `pills` per surface (see usePersistentStrings) and derives the filter
  terms from `[...pills, draft]`.
*/

function normalize(v: string): string {
  return v.trim().toLowerCase();
}

export function FilterInput({
  pills,
  onPillsChange,
  draft,
  onDraftChange,
  label,
  placeholder = "Filter…",
}: {
  pills: string[];
  onPillsChange: (pills: string[]) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Accessible name for the input (visually hidden). */
  label: string;
  placeholder?: string;
}) {
  return (
    <TagsInput
      value={pills}
      onValueChange={(next) => {
        // Enter just committed a pill → the primitive cleared its field; mirror
        // that in our controlled draft so the live term doesn't linger.
        if (next.length > pills.length) onDraftChange("");
        onPillsChange(next);
      }}
      // Reject blank and duplicate (case-insensitive) queries.
      onValidate={(v) => normalize(v).length > 0 && !pills.some((p) => normalize(p) === normalize(v))}
    >
      <TagsInputLabel className="sr-only">{label}</TagsInputLabel>
      <TagsInputList>
        <Search size={15} className="ml-0.5 shrink-0 text-fg-subtle" aria-hidden />
        {pills.map((p) => (
          <TagsInputItem key={p} value={p}>
            {p}
          </TagsInputItem>
        ))}
        <TagsInputInput
          value={draft}
          onChange={(e) => onDraftChange(e.currentTarget.value)}
          placeholder={pills.length ? "Add filter…" : placeholder}
        />
        {(pills.length > 0 || draft.length > 0) && (
          <TagsInputClear onClick={() => onDraftChange("")}>Clear</TagsInputClear>
        )}
      </TagsInputList>
    </TagsInput>
  );
}
