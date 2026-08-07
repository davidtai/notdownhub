#!/usr/bin/env node
// Simplified Technical English (ASD-STE100) style check for the notdownhub docs.
//
// It does not need the licensed STE dictionary. It encodes the writing rules:
//   - one sentence per instruction, short sentences
//   - procedures: <= 20 words per sentence (sentence that starts with an imperative verb)
//   - descriptions: <= 25 words per sentence
//   - paragraphs: <= 6 sentences
//   - a denylist of non-STE words (wordy verbs, idioms, marketing/filler)
//
// Prose only: fenced code blocks, indented code, tables, headings, link-only
// lines, and horizontal rules are skipped. Inline `code` is reduced to one word.
//
// Usage: node scripts/doc-style-check.mjs [file ...]   (defaults to the doc set)
// Exit code 0 = clean, 1 = violations found.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/pull_request_template.md",
  "docs/install.md",
  "docs/operations.md",
  "docs/architecture.md",
  "docs/files.md",
  "examples/demo/README.md",
];

// Files never checked, even when named on the command line. CODE_OF_CONDUCT.md
// is the Contributor Covenant v2.1, reproduced verbatim. Its licensed wording
// uses non-STE terms (e.g. "may"), so rewording it would break attribution.
const EXCLUDE = new Set(["CODE_OF_CONDUCT.md"]);

const MAX_PROCEDURE_WORDS = 20;
const MAX_DESCRIPTION_WORDS = 25;
const MAX_PARAGRAPH_SENTENCES = 6;

// Non-STE words / phrases. Whole-word, case-insensitive. Keep one term per concept
// and plain verbs; ban idioms, filler, and marketing voice.
const DENYLIST = [
  "utilize", "utilise", "leverage", "ensure", "ensures", "ensuring",
  "spin up", "spin-up", "bring up", "bring-up", "stand up", "hook up",
  "seamless", "seamlessly", "simply", "simple", "simplest", "just",
  "easy", "easily", "easier", "honest", "honestly", "folks", "gotcha",
  "footgun", "dogfood", "dog food", "dog-food", "money shot", "robustly",
  "in order to", "a lot of", "lots of", "kinda", "sort of", "etc",
  "blazing", "magic", "magical", "awesome", "powerful", "effortless",
  "obviously", "of course", "note that",
  // STE requirements language: use "must", "can", "do not" — not weak modals.
  "should", "might", "may",
  // STE discourages contractions; use the full form.
  "don't", "doesn't", "can't", "won't", "isn't", "aren't", "didn't",
  "wasn't", "weren't", "wouldn't", "shouldn't", "couldn't", "hasn't", "haven't",
  "it's", "that's", "there's", "here's", "you're", "they're", "we're",
  "let's", "what's", "you'll", "they'll", "we'll", "you've", "they've",
];

// Sentences that start with one of these base verbs are treated as procedures.
const IMPERATIVE_VERBS = new Set([
  "add", "back", "block", "build", "bump", "check", "choose", "clone", "confirm",
  "connect", "copy", "create", "delete", "disable", "dispatch", "do", "download",
  "enable", "extract", "find", "follow", "give", "grant", "install", "join",
  "keep", "kill", "make", "mount", "open", "override", "pass", "point", "prefer",
  "put", "reach", "rebuild", "remove", "restart", "run", "see", "send", "set",
  "skip", "start", "stop", "store", "tail", "target", "treat", "use", "verify",
  "wait", "warm", "write",
]);

const ABBREV = ["e.g.", "i.e.", "etc.", "vs.", "Inc.", "Mr.", "No.", "cf."];

function stripInlineCode(text) {
  // Each inline `code` span becomes a single placeholder word.
  return text.replace(/`[^`]*`/g, "CODE");
}

function protectDots(text) {
  let t = text;
  for (const a of ABBREV) t = t.split(a).join(a.replace(/\./g, ""));
  // Decimals / versions / hostnames: a dot between word chars is not a sentence end.
  t = t.replace(/(\w)\.(\w)/g, "$1$2");
  return t;
}

function restoreDots(text) {
  return text.replace(//g, ".");
}

function splitSentences(paragraph) {
  // Strip markdown emphasis so "word.** Next" splits like "word. Next".
  const noEmphasis = stripInlineCode(paragraph).replace(/\*+/g, "");
  const protectedText = protectDots(noEmphasis);
  // Sentence ends at . ! ? followed by whitespace and a capital / opener.
  // A colon introduces a list or clause in STE, so it is not a sentence end.
  const parts = protectedText.split(/(?<=[.!?])\s+(?=[A-Z(`"'*])/);
  return parts.map((p) => restoreDots(p).trim()).filter(Boolean);
}

function countWords(sentence) {
  const cleaned = sentence
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown link -> its text
    .replace(/[*_>#|]/g, " ")
    .replace(/[.,;:!?()"']/g, " ");
  return cleaned.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

function firstWord(sentence) {
  const m = sentence
    .replace(/^[-*+\d.)>\s]+/, "")
    .replace(/[*_`>#]/g, "")
    .match(/[A-Za-z][A-Za-z-]*/);
  return m ? m[0].toLowerCase() : "";
}

function isProcedure(sentence) {
  return IMPERATIVE_VERBS.has(firstWord(sentence));
}

function findDenylist(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const term of DENYLIST) {
    const re = new RegExp(`(?<![A-Za-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "g");
    let m;
    while ((m = re.exec(lower)) !== null) hits.push(term);
  }
  return hits;
}

// Break a markdown file into prose blocks with starting line numbers, skipping
// code, tables, headings, and rule/link-only lines.
function proseBlocks(src) {
  const lines = src.split("\n");
  const blocks = [];
  let cur = null;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, "  ");
    if (/^\s*```/.test(line)) { inFence = !inFence; cur = null; continue; }
    if (inFence) continue;
    const trimmed = line.trim();
    const skip =
      trimmed === "" ||
      /^#{1,6}\s/.test(trimmed) ||          // heading
      /^\|/.test(trimmed) ||                 // table row
      /^[-*_]{3,}$/.test(trimmed) ||         // horizontal rule
      /^\s{4,}\S/.test(line) ||              // indented code
      /^\[[^\]]+\]:\s*\S+$/.test(trimmed) || // link reference
      /^<\/?\w/.test(trimmed);               // raw HTML line
    if (skip) { if (trimmed === "") cur = null; else cur = null; continue; }
    // A list marker starts a new block, so each list item is checked on its own
    // (a bulleted list is not one long paragraph).
    const isListItem = /^([-*+]|\d+\.)\s+/.test(trimmed);
    if (isListItem || !cur) { cur = { line: i + 1, text: "" }; blocks.push(cur); }
    // Strip leading list/quote markers for sentence analysis.
    cur.text += (cur.text ? " " : "") + trimmed.replace(/^([-*+]|\d+\.|>)\s+/, "");
  }
  return blocks;
}

function checkFile(absPath) {
  const rel = relative(ROOT, absPath);
  const src = readFileSync(absPath, "utf8");
  const violations = [];
  for (const block of proseBlocks(src)) {
    const sentences = splitSentences(block.text);
    if (sentences.length > MAX_PARAGRAPH_SENTENCES) {
      violations.push(`${rel}:${block.line}  paragraph has ${sentences.length} sentences (max ${MAX_PARAGRAPH_SENTENCES})`);
    }
    for (const s of sentences) {
      const words = countWords(s);
      const limit = isProcedure(s) ? MAX_PROCEDURE_WORDS : MAX_DESCRIPTION_WORDS;
      if (words > limit) {
        const kind = limit === MAX_PROCEDURE_WORDS ? "procedure" : "description";
        violations.push(`${rel}:${block.line}  ${kind} sentence has ${words} words (max ${limit}): "${s.slice(0, 70)}${s.length > 70 ? "…" : ""}"`);
      }
      for (const term of findDenylist(s)) {
        violations.push(`${rel}:${block.line}  banned word "${term}": "${s.slice(0, 70)}${s.length > 70 ? "…" : ""}"`);
      }
    }
  }
  return violations;
}

const files = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES)
  .filter((f) => !EXCLUDE.has(f))
  .map((f) => join(ROOT, f));

let total = 0;
for (const f of files) {
  let v = [];
  try {
    v = checkFile(f);
  } catch (err) {
    console.error(`skip ${f}: ${err.message}`);
    continue;
  }
  for (const line of v) console.log(line);
  total += v.length;
}

if (total === 0) {
  console.log("STE style check: clean");
  process.exit(0);
} else {
  console.log(`\nSTE style check: ${total} violation(s)`);
  process.exit(1);
}
