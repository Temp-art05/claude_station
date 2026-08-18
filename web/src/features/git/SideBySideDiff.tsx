import { useMemo } from "react";
import { RotateCcw } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

interface Cell {
  no: number;
  text: string;
}

type Row =
  | { kind: "hunk"; label: string; index: number }
  | { kind: "ctx" | "change"; left: Cell | null; right: Cell | null };

/**
 * Split a single-file unified patch into standalone hunk patches: each one is
 * the file header + that hunk, valid input for `git apply -R` on its own —
 * what the per-hunk Rollback button sends to the server.
 */
export function splitHunks(patch: string): string[] {
  const lines = patch.split("\n");
  const headerLines: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = [line];
      hunks.push(current);
    } else if (current) {
      // Hunk body: context/add/del/no-newline lines only; anything else ends it.
      if (/^[ +\-\\]/.test(line) || line === "") current.push(line);
      else current = null;
    } else {
      headerLines.push(line);
    }
  }
  const header = headerLines.filter((l) => l.trim() !== "").join("\n");
  return hunks.map((h) => `${header}\n${h.join("\n").replace(/\n+$/, "")}\n`);
}

/**
 * Turn one file's unified patch (`git diff HEAD -- <file>`) into side-by-side
 * rows. Deleted and added runs inside a hunk are zipped against each other, the
 * way JetBrains aligns them.
 */
export function parsePatchRows(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let hunkIndex = -1;
  let dels: Cell[] = [];
  let adds: Cell[] = [];

  const flush = () => {
    const max = Math.max(dels.length, adds.length);
    for (let i = 0; i < max; i += 1) {
      rows.push({ kind: "change", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      flush();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      hunkIndex += 1;
      rows.push({
        kind: "hunk",
        label: `@@ −${hunk[1]} +${hunk[2]} @@${hunk[3] ?? ""}`,
        index: hunkIndex,
      });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("-")) {
      dels.push({ no: oldNo++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      adds.push({ no: newNo++, text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      flush();
      rows.push({
        kind: "ctx",
        left: { no: oldNo++, text: line.slice(1) },
        right: { no: newNo++, text: line.slice(1) },
      });
    } else {
      // "diff --git", "index", headers of the next file — hunk is over.
      flush();
      inHunk = false;
    }
  }
  flush();
  return rows;
}

function Half({ cell, tone }: { cell: Cell | null; tone: "del" | "add" }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1",
        cell ? (tone === "del" ? "bg-err/10" : "bg-ok/10") : "bg-white/3",
      )}
    >
      <span className="w-11 shrink-0 border-r border-hairline px-1.5 text-right text-ink-faint select-none">
        {cell?.no ?? ""}
      </span>
      <span className="min-w-0 flex-1 px-2 break-all whitespace-pre-wrap">{cell?.text ?? ""}</span>
    </div>
  );
}

export function SideBySideDiff({
  patch,
  onRevertHunk,
}: {
  patch: string;
  /** Present only for working-tree diffs: the ⤺ Rollback button per hunk. */
  onRevertHunk?: (hunkIndex: number) => void;
}) {
  const rows = useMemo(() => parsePatchRows(patch), [patch]);

  if (rows.length === 0) {
    return <p className="p-4 text-xs text-ink-faint">No changes against HEAD.</p>;
  }

  return (
    <div className="h-full overflow-auto bg-base font-mono m3-label-md leading-relaxed">
      {rows.map((row, i) => {
        if (row.kind === "hunk") {
          return (
            <div
              key={i}
              className="group flex items-center gap-2 border-y border-hairline bg-surface-2 px-3 py-0.5 m3-label-sm text-accent"
            >
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {onRevertHunk && (
                <button
                  onClick={() => onRevertHunk(row.index)}
                  title="Rollback this hunk — revert just these lines in the working tree"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-pill border border-hairline px-1.5 py-0.5 m3-label-sm text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 hover:border-err/40 hover:text-err"
                >
                  <RotateCcw size={16} /> Rollback
                </button>
              )}
            </div>
          );
        }
        if (row.kind === "ctx") {
          return (
            <div key={i} className="flex">
              <div className="flex min-w-0 flex-1 border-r border-hairline">
                <span className="w-11 shrink-0 border-r border-hairline px-1.5 text-right text-ink-faint select-none">
                  {row.left?.no}
                </span>
                <span className="min-w-0 flex-1 px-2 break-all whitespace-pre-wrap">
                  {row.left?.text}
                </span>
              </div>
              <div className="flex min-w-0 flex-1">
                <span className="w-11 shrink-0 border-r border-hairline px-1.5 text-right text-ink-faint select-none">
                  {row.right?.no}
                </span>
                <span className="min-w-0 flex-1 px-2 break-all whitespace-pre-wrap">
                  {row.right?.text}
                </span>
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="flex">
            <div className="flex min-w-0 flex-1 border-r border-hairline">
              <Half cell={row.left} tone="del" />
            </div>
            <Half cell={row.right} tone="add" />
          </div>
        );
      })}
    </div>
  );
}
