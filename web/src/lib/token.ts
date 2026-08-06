const STORAGE_KEY = "claude-station.token";

/**
 * The token never ships with the app — in dev or in production. It arrives
 * either from the `?t=` link the server prints, or typed in once. After that it
 * lives in localStorage and the address bar is cleaned up so the URL is safe to
 * share or bookmark.
 */
function bootstrap(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("t");
  if (fromUrl) {
    localStorage.setItem(STORAGE_KEY, fromUrl);
    url.searchParams.delete("t");
    window.history.replaceState({}, "", url.toString());
    return fromUrl;
  }
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

let token = bootstrap();

export function getToken(): string {
  return token;
}

export function setToken(value: string): void {
  token = value.trim();
  localStorage.setItem(STORAGE_KEY, token);
}

export function hasToken(): boolean {
  return token.length > 0;
}

/** WS handshakes can't send headers, so the token rides in the query string. */
export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}?t=${encodeURIComponent(token)}`;
}
