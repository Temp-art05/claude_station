import { getToken, reportTokenRejected } from "./token";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-cs-token": getToken() };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) reportTokenRejected();
    let message = res.statusText;
    let issues: unknown;
    try {
      const data = await res.json();
      message = data.error ?? message;
      issues = data.issues;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, issues);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Does the server actually accept this token? Presence in localStorage proves
 * nothing — a stale value 401s every request while the UI still looks fine, so
 * the gate asks before rendering. Only an explicit 401 means "wrong token": a
 * server that is down or misconfigured must not send the user to a prompt that
 * cannot fix it.
 */
export async function verifyToken(candidate: string): Promise<"ok" | "invalid" | "unreachable"> {
  if (!candidate.trim()) return "invalid";
  try {
    const res = await fetch("/api/auth/check", { headers: { "x-cs-token": candidate.trim() } });
    if (res.status === 401) return "invalid";
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  delete: <T = void>(url: string) => request<T>("DELETE", url),
};
