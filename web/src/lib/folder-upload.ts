import { ApiError } from "./api";
import { getToken } from "./token";

/**
 * Folder imports: pick a directory (webkitdirectory input) or drop one from
 * Finder. Each file travels as one multipart part whose filename is the path
 * relative to the dropped folder — the server rebuilds the tree from that.
 */

export interface PickedFile {
  file: File;
  /** e.g. "MyFolder/sub/notes.md" — always includes the root folder segment. */
  relPath: string;
}

const SKIP_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);

function skippable(relPath: string): boolean {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1]?.toLowerCase() ?? "";
  return SKIP_FILES.has(base) || segments.some((s) => SKIP_DIRS.has(s.toLowerCase()));
}

/** Files from an `<input type="file" webkitdirectory>` selection. */
export function filesFromDirectoryInput(list: FileList): PickedFile[] {
  return Array.from(list)
    .map((file) => ({ file, relPath: file.webkitRelativePath || file.name }))
    .filter((f) => !skippable(f.relPath));
}

/** The TS DOM types don't know webkitdirectory — spread this onto the input. */
export const directoryInputProps = {
  webkitdirectory: "",
  directory: "",
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Split a drop into folders (recursively walked) and loose files, so callers
 * can route folders to the folder endpoint and files to the classic one.
 * Must be called synchronously from the drop handler — DataTransfer is
 * neutered once the handler yields.
 */
export async function collectDropped(
  items: DataTransferItemList,
): Promise<{ folders: { name: string; files: PickedFile[] }[]; looseFiles: File[] }> {
  const entries: { entry: FileSystemEntry | null; item: File | null }[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    entries.push({ entry: item.webkitGetAsEntry(), item: item.getAsFile() });
  }

  const folders: { name: string; files: PickedFile[] }[] = [];
  const looseFiles: File[] = [];
  for (const { entry, item } of entries) {
    if (entry?.isDirectory) {
      const files = await walkDirectory(entry as FileSystemDirectoryEntry, entry.name);
      folders.push({ name: entry.name, files });
    } else if (item) {
      looseFiles.push(item);
    }
  }
  return { folders, looseFiles };
}

async function walkDirectory(dir: FileSystemDirectoryEntry, prefix: string): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const reader = dir.createReader();
  // Chrome returns at most 100 entries per readEntries call — loop until empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    for (const entry of batch) {
      const relPath = `${prefix}/${entry.name}`;
      if (skippable(relPath)) continue;
      if (entry.isDirectory) {
        out.push(...(await walkDirectory(entry as FileSystemDirectoryEntry, relPath)));
      } else if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        out.push({ file, relPath });
      }
    }
  }
  return out;
}

/** Multipart POST of many files — the part filename carries each relative path. */
export async function uploadFiles<T>(
  url: string,
  files: PickedFile[],
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const f of files) form.append("files", f.file, f.relPath);

  const res = await fetch(url, {
    method: "POST",
    headers: { "x-cs-token": getToken() },
    body: form,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
