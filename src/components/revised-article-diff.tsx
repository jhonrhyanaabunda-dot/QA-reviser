"use client";

import { useMemo, useRef, useState } from "react";
import { diffWords, type Change } from "diff";
import { markdownToHtml } from "@/lib/markdown";

/**
 * The revised article, shown as what changed rather than as a wall of text.
 *
 * A safe auto-fix is by definition a small, local substitution — one run
 * changed three things across 8,268 words. Rendering the whole article and
 * asking the reader to spot the difference is not review, it is a memory test.
 * So the default view collapses the untouched runs and shows only the edits
 * with enough surrounding words to judge them.
 */

interface AppliedFix {
  rule_code: string | null;
  before_text: string;
  after_text: string;
  reason: string | null;
}

/** Words of untouched text kept on either side of a change. */
const CONTEXT_WORDS = 24;

export function RevisedArticleDiff({
  original,
  revised,
  fixes,
}: {
  original: string;
  revised: string;
  fixes: AppliedFix[];
}) {
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState<"html" | null>(null);
  const [cursor, setCursor] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  const parts = useMemo(() => diffWords(original, revised), [original, revised]);

  /**
   * One edit, not two.
   *
   * diffWords emits a `removed` part and an `added` part for every
   * substitution, so counting parts reports double. A replacement of one word
   * by another is a single change to a reader, and the number here has to
   * reconcile with the fix count in the summary above or the report reads as
   * self-contradictory.
   */
  const changeCount = useMemo(() => {
    let count = 0;
    let inRun = false;
    for (const part of parts) {
      const changed = Boolean(part.added || part.removed);
      if (changed && !inRun) count += 1;
      inRun = changed;
    }
    return count;
  }, [parts]);

  const segments = useMemo(
    () => (showAll ? parts.map((part) => ({ part, elided: 0 })) : collapse(parts)),
    [parts, showAll],
  );

  // Which rule produced each edit, matched on the text the fix recorded.
  const attribution = useMemo(() => attribute(fixes), [fixes]);

  if (changeCount === 0) {
    return (
      <div className="panel p-5">
        <h3 className="text-sm font-semibold">No changes were applied</h3>
        <p className="mt-1 text-sm muted">
          Every finding in this audit needed editorial judgement, so nothing was
          rewritten automatically. The revised article is identical to the original.
        </p>
        <CopyHtml markdown={revised} copied={copied} setCopied={setCopied} className="mt-4" />
      </div>
    );
  }

  const jump = (direction: 1 | -1) => {
    const marks = container.current?.querySelectorAll("[data-change-start]");
    if (!marks || marks.length === 0) return;
    const next = (cursor + direction + marks.length) % marks.length;
    setCursor(next);
    marks[next].scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">
            {changeCount.toLocaleString()} text edit{changeCount === 1 ? "" : "s"}
            <span className="ml-1.5 font-normal muted">
              from {fixes.length} auto-fix{fixes.length === 1 ? "" : "es"}
            </span>
          </h3>
          <div className="flex gap-1">
            <button className="btn text-xs" onClick={() => jump(-1)} aria-label="Previous change">
              &larr; prev
            </button>
            <button className="btn text-xs" onClick={() => jump(1)} aria-label="Next change">
              next &rarr;
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn text-xs" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show changes only" : "Show whole article"}
          </button>
          <CopyHtml markdown={revised} copied={copied} setCopied={setCopied} />
        </div>
      </div>

      <p className="mb-3 text-xs muted">
        <span style={{ color: "var(--critical)", textDecoration: "line-through" }}>removed</span>
        {" · "}
        <span style={{ color: "var(--good)" }}>added</span>
        {" · "}
        Only mechanical substitutions are applied automatically; everything else is
        listed under Issues for a person to decide.
      </p>

      <div
        ref={container}
        className="max-h-[36rem] overflow-auto rounded p-4 text-sm leading-relaxed"
        style={{ background: "var(--bg)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}
      >
        {(() => {
          // Marks the first element of each edit run so prev/next steps once
          // per edit rather than twice (removed half, then added half).
          let previousWasChange = false;
          return segments.map(({ part, elided }, index) => {
            const changed = Boolean(part.added || part.removed);
            const startsRun = changed && !previousWasChange;
            previousWasChange = changed;
            return renderSegment({ part, elided, index, startsRun, attribution });
          });
        })()}
      </div>
    </div>
  );
}

function renderSegment({
  part,
  elided,
  index,
  startsRun,
  attribution,
}: {
  part: Change;
  elided: number;
  index: number;
  startsRun: boolean;
  attribution: Map<string, string>;
}) {
  if (elided > 0) {
    return (
      <span key={index} className="my-2 block text-center text-xs muted">
        &middot; &middot; &middot; {elided.toLocaleString()} unchanged words &middot; &middot; &middot;
      </span>
    );
  }

  const title = attribution.get(part.value.trim());

  if (part.added) {
    return (
      <mark
        key={index}
        {...(startsRun ? { "data-change-start": "" } : {})}
        title={title ?? "Applied automatically"}
        style={{
          background: "color-mix(in srgb, var(--good) 18%, transparent)",
          color: "var(--good)",
          fontWeight: 600,
          borderRadius: "2px",
          padding: "0 1px",
        }}
      >
        {part.value}
      </mark>
    );
  }

  if (part.removed) {
    return (
      <del
        key={index}
        {...(startsRun ? { "data-change-start": "" } : {})}
        title={title ?? "Replaced automatically"}
        style={{
          background: "color-mix(in srgb, var(--critical) 15%, transparent)",
          color: "var(--critical)",
          borderRadius: "2px",
          padding: "0 1px",
        }}
      >
        {part.value}
      </del>
    );
  }

  return <span key={index}>{part.value}</span>;
}

function CopyHtml({
  markdown,
  copied,
  setCopied,
  className,
}: {
  markdown: string;
  copied: "html" | null;
  setCopied: (v: "html" | null) => void;
  className?: string;
}) {
  return (
    <button
      className={`btn btn-primary text-xs ${className ?? ""}`}
      onClick={async () => {
        await navigator.clipboard.writeText(markdownToHtml(markdown));
        setCopied("html");
        setTimeout(() => setCopied(null), 1600);
      }}
      title="Copy the revised article as HTML, ready to paste into a CMS"
    >
      {copied === "html" ? "Copied HTML" : "Copy as HTML"}
    </button>
  );
}

/**
 * Replace long untouched runs with a marker, keeping CONTEXT_WORDS on each
 * side of every edit so a reviewer can see what the change sits inside.
 */
function collapse(parts: Change[]): { part: Change; elided: number }[] {
  const out: { part: Change; elided: number }[] = [];

  parts.forEach((part, index) => {
    if (part.added || part.removed) {
      out.push({ part, elided: 0 });
      return;
    }

    const words = part.value.split(/(\s+)/);
    const wordCount = part.value.trim() ? part.value.trim().split(/\s+/).length : 0;
    const isFirst = index === 0;
    const isLast = index === parts.length - 1;
    const budget = CONTEXT_WORDS * 2;

    if (wordCount <= budget) {
      out.push({ part, elided: 0 });
      return;
    }

    const head = words.slice(0, CONTEXT_WORDS * 2).join("");
    const tail = words.slice(-CONTEXT_WORDS * 2).join("");

    if (!isFirst) out.push({ part: { ...part, value: head }, elided: 0 });
    out.push({ part, elided: wordCount - (isFirst || isLast ? CONTEXT_WORDS : budget) });
    if (!isLast) out.push({ part: { ...part, value: tail }, elided: 0 });
  });

  return out;
}

/** Map a changed string back to the rule that caused it, where we can. */
function attribute(fixes: AppliedFix[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const fix of fixes) {
    const label = fix.rule_code ? `${fix.rule_code}: ${fix.reason ?? ""}`.trim() : fix.reason ?? "";
    if (fix.after_text) map.set(fix.after_text.trim(), label);
    if (fix.before_text) map.set(fix.before_text.trim(), label);
  }
  return map;
}
