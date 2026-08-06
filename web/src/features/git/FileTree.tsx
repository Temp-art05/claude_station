import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: { name: string; path: string }[];
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      let child = node.dirs.get(name);
      if (!child) {
        child = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1]!, path: p });
  }
  return root;
}

interface Props {
  files: string[];
  selected: string | null;
  /** Paths with local modifications get the accent tint, like Android Studio. */
  changed?: Set<string>;
  onOpen: (path: string) => void;
}

/** Lazy project tree: children render only when a directory is expanded. */
export function FileTree({ files, selected, changed, onOpen }: Props) {
  const root = useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // A directory containing any changed file gets a dot so edits stay findable.
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const p of changed ?? []) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  }, [changed]);

  const renderDir = (node: DirNode, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {dirs.map((dir) => {
          const isOpen = open.has(dir.path);
          return (
            <div key={dir.path}>
              <button
                onClick={() => toggle(dir.path)}
                style={{ paddingLeft: depth * 14 + 6 }}
                className="flex w-full cursor-pointer items-center gap-1 rounded-md py-0.5 pr-2 text-left text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {isOpen ? (
                  <FolderOpen size={12} className="shrink-0 text-accent/70" />
                ) : (
                  <Folder size={12} className="shrink-0 text-accent/70" />
                )}
                <span className="truncate">{dir.name}</span>
                {changedDirs.has(dir.path) && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                )}
              </button>
              {isOpen && renderDir(dir, depth + 1)}
            </div>
          );
        })}
        {node.files
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => (
            <button
              key={file.path}
              onClick={() => onOpen(file.path)}
              style={{ paddingLeft: depth * 14 + 6 + 12 }}
              title={file.path}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 text-left font-mono text-[11px]",
                selected === file.path ? "bg-surface-3 text-ink" : "hover:bg-surface-2",
                changed?.has(file.path) ? "text-warn" : "text-ink-muted",
              )}
            >
              <FileText size={11} className="shrink-0 opacity-60" />
              <span className="truncate">{file.name}</span>
            </button>
          ))}
      </>
    );
  };

  if (files.length === 0) {
    return <p className="px-2 py-1 text-xs text-ink-faint">No files (not a git repo?).</p>;
  }
  return <div>{renderDir(root, 0)}</div>;
}
