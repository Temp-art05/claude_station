import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import JSZip from "jszip";
import { tooLarge } from "./path-safety";

export interface ZipEntry {
  /** Path inside the archive, always POSIX-separated. */
  path: string;
  data: Buffer | string;
}

/**
 * A whole tree is read into memory before it is zipped, so an oversized folder
 * would take the server down rather than fail one download. Refuse past this.
 */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Every file under `dir`, as archive entries rooted at `prefix`. Symlinks are
 * followed by statSync but only regular files are read, so a link pointing
 * outside the data dir contributes its contents, never a traversal path.
 */
export function dirEntries(
  dir: string,
  prefix = "",
  budget = { bytes: MAX_ARCHIVE_BYTES },
): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // broken symlink / raced deletion — skip rather than fail the download
    }
    if (stat.isDirectory()) {
      out.push(...dirEntries(abs, rel, budget));
      continue;
    }
    if (!stat.isFile()) continue;
    budget.bytes -= stat.size;
    if (budget.bytes < 0) {
      throw tooLarge(
        `Too big to download as a zip (over ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB) — copy it from the data directory instead`,
      );
    }
    out.push({ path: rel, data: readFileSync(abs) });
  }
  return out;
}

export async function zipEntries(entries: ZipEntry[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.path.split(sep).join("/"), entry.data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Content-Disposition takes a quoted string, so a name containing `"` or a
 * newline would let the caller inject header fields. Strip anything that isn't
 * safe in a filename and fall back to a constant when nothing survives.
 */
export function attachmentName(name: string, ext: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "download"}${ext}`;
}

/** RFC 5987: percent-encode, then also escape what encodeURIComponent leaves. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A full Content-Disposition value. `filename` stays ASCII so old clients get
 * something; `filename*` carries the real name, so "Trợ lý.zip" survives its
 * accents instead of arriving as "Tr-l.zip". Path separators are folded and
 * control chars dropped in both forms — a name is never allowed to steer where
 * the download lands or to inject another header field.
 */
export function contentDisposition(
  name: string,
  ext: string,
  type: "attachment" | "inline" = "attachment",
): string {
  const exact = `${name}${ext}`
    .replace(/[/\\]+/g, "-")
    .replace(/["\p{C}]+/gu, "")
    .trim();
  const ascii = attachmentName(name, ext);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(exact || ascii)}`;
}
