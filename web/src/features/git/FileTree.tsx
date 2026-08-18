import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "@/components/ui/icons";
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
  /**
   * Paths git is ignoring. They are listed — `.env` is a file people come here to
   * read — but dimmed, so nobody mistakes one for something the repo tracks.
   */
  ignored?: Set<string>;
  onOpen: (path: string) => void;
  /** Bump nonce to expand a path's ancestors and scroll it into view. */
  reveal?: { path: string; nonce: number } | null;
}

/** Shared empty map so `activeOverrides` keeps a stable identity when reset. */
const EMPTY_OVERRIDES: Map<string, boolean> = new Map();

/** Lazy project tree: children render only when a directory is expanded. */
export function FileTree({ files, selected, changed, ignored, onOpen, reveal }: Props) {
  const root = useMemo(() => buildTree(files), [files]);
  const revealRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Which directories are expanded is DERIVED, not stored: a reveal opens the
   * ancestors of its path, and clicks are overrides on top of that. Expanding
   * them by calling setOpen from an effect (what this used to do) is the
   * cascading-render pattern React 19 warns about.
   *
   * Overrides are tagged with the reveal that was current when they were made,
   * so a new reveal drops them — otherwise a directory you had collapsed would
   * stay shut over the very file you asked to be shown.
   */
  const nonce = reveal?.nonce ?? -1;
  const [overrides, setOverrides] = useState<{ nonce: number; map: Map<string, boolean> }>({
    nonce,
    map: new Map(),
  });
  const activeOverrides = overrides.nonce === nonce ? overrides.map : EMPTY_OVERRIDES;

  const revealedAncestors = useMemo(() => {
    const dirs = new Set<string>();
    if (!reveal) return dirs;
    const parts = reveal.path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    return dirs;
  }, [reveal]);

  const isExpanded = (path: string) => activeOverrides.get(path) ?? revealedAncestors.has(path);

  const toggle = (path: string) =>
    setOverrides({ nonce, map: new Map(activeOverrides).set(path, !isExpanded(path)) });

  // Scroll once the revealed rows have committed to the DOM.
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => {
      revealRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [reveal]);

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
          const isOpen = isExpanded(dir.path);
          return (
            <div key={dir.path}>
              <button
                onClick={() => toggle(dir.path)}
                style={{ paddingLeft: depth * 14 + 6 }}
                className="flex w-full cursor-pointer items-center gap-1 rounded-md py-0.5 pr-2 text-left text-xs text-ink-muted hover:bg-white/6 hover:text-ink"
              >
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {isOpen ? (
                  <FolderOpen size={16} className="shrink-0 text-accent/70" />
                ) : (
                  <Folder size={16} className="shrink-0 text-accent/70" />
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
              ref={reveal && file.path === reveal.path ? revealRef : undefined}
              onClick={() => onOpen(file.path)}
              style={{ paddingLeft: depth * 14 + 6 + 12 }}
              title={ignored?.has(file.path) ? `${file.path} — ignored by git` : file.path}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 text-left font-mono m3-label-sm",
                selected === file.path
                  ? "bg-secondary-container text-on-secondary-container"
                  : "hover:bg-white/6",
                changed?.has(file.path)
                  ? "text-warn"
                  : ignored?.has(file.path)
                    ? "text-ink-faint italic"
                    : "text-ink-muted",
              )}
            >
              <FileText size={16} className="shrink-0 opacity-60" />
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
