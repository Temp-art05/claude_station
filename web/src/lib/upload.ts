import { ApiError } from "./api";
import { getToken } from "./token";

/** Multipart POST — fetch sets the boundary, so no Content-Type here. */
export async function uploadFile<T>(
  url: string,
  file: File | Blob,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", file, file instanceof File ? file.name : "pasted.png");

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

export function fileUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}t=${encodeURIComponent(getToken())}`;
}
