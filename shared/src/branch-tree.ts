/**
 * Grouping for branch lists: `version/4.0.0` + `version/4.1.0` become a `version`
 * folder holding `4.0.0` and `4.1.0`, the way Android Studio's branch popup shows
 * them. Leaves always keep the full ref in `name` — that is what gets checked out,
 * so a shortened `label` can never be mistaken for a branch of its own.
 */
export type BranchNode =
  | { kind: "leaf"; name: string; label: string }
  | { kind: "folder"; label: string; path: string; count: number; children: BranchNode[] };

interface Entry {
  /** Full ref name, e.g. "origin/feature/x". */
  name: string;
  /** Segments still to be grouped, e.g. ["feature", "x"] below the "origin" folder. */
  rest: string[];
}

const byLabel = (a: BranchNode, b: BranchNode): number =>
  a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });

function build(entries: Entry[], prefix: string): BranchNode[] {
  const folders = new Map<string, Entry[]>();
  const leaves: BranchNode[] = [];
  for (const entry of entries) {
    const [head, ...tail] = entry.rest;
    if (head === undefined || tail.length === 0) {
      leaves.push({ kind: "leaf", name: entry.name, label: entry.rest.join("/") || entry.name });
      continue;
    }
    const group = folders.get(head);
    if (group) group.push({ name: entry.name, rest: tail });
    else folders.set(head, [{ name: entry.name, rest: tail }]);
  }
  const folderNodes: BranchNode[] = [];
  for (const [head, group] of folders) {
    // A folder holding a single branch is pure noise — show that branch with its
    // remaining path as the label instead.
    if (group.length < 2) {
      const only = group[0]!;
      leaves.push({ kind: "leaf", name: only.name, label: [head, ...only.rest].join("/") });
      continue;
    }
    const path = prefix ? `${prefix}/${head}` : head;
    folderNodes.push({
      kind: "folder",
      label: head,
      path,
      count: group.length,
      children: build(group, path),
    });
  }
  folderNodes.sort(byLabel);
  leaves.sort(byLabel);
  return [...folderNodes, ...leaves];
}

/** Folders first, then bare branches, each group sorted naturally (4.0.0 < 4.0.10). */
export function buildBranchTree(names: string[]): BranchNode[] {
  return build(
    names.map((name) => ({ name, rest: name.split("/") })),
    "",
  );
}

/** Folder paths on the way down to `name` — used to open the current branch's folders. */
export function branchAncestors(name: string): string[] {
  const segments = name.split("/");
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}
