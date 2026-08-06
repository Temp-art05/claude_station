import { badRequest } from "./path-safety";

/**
 * Shared multipart reading. Imports are documents, not videos, so every part is
 * buffered in memory — the caps below are the OOM guard for folder uploads.
 */

interface FilePart {
  type: "file";
  filename: string;
  toBuffer(): Promise<Buffer>;
}
interface FieldPart {
  type: "field";
  fieldname: string;
  value: unknown;
}
type MultipartRequest = {
  file: (opts?: { limits?: { fileSize?: number } }) => Promise<
    | { filename: string; toBuffer(): Promise<Buffer>; fields: Record<string, unknown> }
    | undefined
  >;
  parts: (opts?: {
    limits?: { fileSize?: number };
  }) => AsyncIterableIterator<FilePart | FieldPart>;
};

/** Junk the OS drops into every folder — never worth importing. */
const SKIP_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);

export interface UploadedFile {
  /** Sanitised path relative to the dropped folder, e.g. "MyFolder/sub/a.md". */
  relPath: string;
  data: Buffer;
}

/**
 * Folder uploads send each file's relative path as the multipart part filename.
 * Browsers never send `..`, but curl can — this is the server-side defense.
 */
export function sanitizeRelPath(input: string): string {
  const normalized = input.replace(/\\/g, "/").trim();
  if (!normalized || normalized.includes("\0")) throw badRequest(`Invalid path: ${input}`);
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw badRequest(`Absolute paths are not allowed: ${input}`);
  }
  const segments = normalized.split("/").filter((s) => s !== "");
  if (segments.length === 0 || segments.length > 32) throw badRequest(`Invalid path: ${input}`);
  const clean = segments.map((seg) => {
    if (seg === "." || seg === "..") throw badRequest(`Path may not contain "${seg}": ${input}`);
    // Dotfiles stay (an app bundle needs its .env / .gitignore) — only the
    // navigation segments above are dangerous.
    const safe = seg.trim().slice(0, 180);
    if (!safe || /^\.+$/.test(safe)) throw badRequest(`Invalid path segment in: ${input}`);
    return safe;
  });
  const joined = clean.join("/");
  if (joined.length > 1024) throw badRequest("Path too long");
  return joined;
}

/** OS junk and VCS internals are skipped rather than rejected. */
export function isSkippablePath(relPath: string): boolean {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1]?.toLowerCase() ?? "";
  return SKIP_FILES.has(base) || segments.some((s) => SKIP_DIRS.has(s.toLowerCase()));
}

/** The single-file shape used by the existing import endpoints. */
export async function readSinglePart(
  req: unknown,
  maxFileSize: number,
): Promise<{ filename: string; data: Buffer; description: string }> {
  const part = await (req as MultipartRequest).file({ limits: { fileSize: maxFileSize } });
  if (!part) throw badRequest("No file in request");
  const data = await part.toBuffer();
  const field = part.fields.description as { value?: unknown } | undefined;
  const description = typeof field?.value === "string" ? field.value : "";
  return { filename: part.filename, data, description };
}

export async function readUploadParts(
  req: unknown,
  opts: { maxFileSize: number; maxFiles?: number; maxTotalBytes?: number },
): Promise<{ files: UploadedFile[]; fields: Record<string, string> }> {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxTotalBytes = opts.maxTotalBytes ?? 256 * 1024 * 1024;

  const files: UploadedFile[] = [];
  const fields: Record<string, string> = {};
  let totalBytes = 0;

  for await (const part of (req as MultipartRequest).parts({
    limits: { fileSize: opts.maxFileSize },
  })) {
    if (part.type !== "file") {
      if (typeof part.value === "string") fields[part.fieldname] = part.value;
      continue;
    }
    const relPath = sanitizeRelPath(part.filename);
    if (isSkippablePath(relPath)) {
      await part.toBuffer(); // drain the stream so the next part can arrive
      continue;
    }
    if (files.length >= maxFiles) {
      throw badRequest(`Too many files — the limit is ${maxFiles} per import`);
    }
    const data = await part.toBuffer();
    totalBytes += data.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw badRequest(
        `Import too large — the limit is ${Math.round(maxTotalBytes / 1024 / 1024)} MB total`,
      );
    }
    files.push({ relPath, data });
  }

  if (files.length === 0) throw badRequest("No files in request");
  return { files, fields };
}

/**
 * A dropped folder arrives with every relPath under one root segment
 * ("MyFolder/…"). Returns the root name and the paths with it stripped.
 */
export function splitFolderRoot(files: UploadedFile[]): {
  rootName: string;
  files: UploadedFile[];
} {
  const first = files[0]!.relPath.split("/")[0]!;
  const shared = files.every((f) => f.relPath.split("/")[0] === first && f.relPath.includes("/"));
  if (!shared) return { rootName: "import", files };
  return {
    rootName: first,
    files: files.map((f) => ({ ...f, relPath: f.relPath.split("/").slice(1).join("/") })),
  };
}
