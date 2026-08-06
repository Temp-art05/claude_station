import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { verifyToken } from "@/lib/api";
import { getToken, hasToken, onTokenRejected, setToken } from "@/lib/token";

type Phase = "checking" | "ok" | "prompt";

/**
 * The API refuses every request without the shared token. Normally it arrives
 * via the `?t=` link the server prints; this is the manual fallback.
 *
 * A stored token is verified before the app renders — holding *some* token is
 * not the same as holding the right one, and an unverified stale value turns
 * into a 401 behind every screen instead of an actionable prompt.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>(hasToken() ? "checking" : "prompt");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The token can die while the app is open — come back to the prompt instead
  // of leaving a shell where every panel fails on its own.
  useEffect(
    () =>
      onTokenRejected(() => {
        setError("The server rejected the token — it was restarted, or the data dir changed.");
        setValue("");
        setPhase("prompt");
      }),
    [],
  );

  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    void verifyToken(getToken()).then((result) => {
      if (cancelled) return;
      if (result === "invalid") {
        setError("The saved token was rejected — paste the current one.");
        setPhase("prompt");
      } else {
        // "unreachable" is the app's problem to surface, not the gate's: a down
        // server is not a bad token, and prompting for one would be a dead end.
        setPhase("ok");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  async function submit() {
    const candidate = value.trim();
    if (!candidate || busy) return;
    setBusy(true);
    setError(null);
    const result = await verifyToken(candidate);
    setBusy(false);
    if (result === "invalid") {
      setError("Rejected by the server — check the contents of data/.token.");
      return;
    }
    setToken(candidate);
    // Everything cached under the dead token is an error state — start clean.
    queryClient.clear();
    setPhase("ok");
  }

  if (phase === "ok") return <>{children}</>;

  if (phase === "checking") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-xs text-ink-muted">Checking token…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-edge bg-surface p-6">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={16} className="text-accent" />
          <h1 className="text-sm font-semibold">API token required</h1>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-ink-muted">
          Open the link the server printed on start (it contains{" "}
          <code className="font-mono text-ink">?t=…</code>), or paste the contents of{" "}
          <code className="font-mono text-ink">data/.token</code> below.
        </p>
        <Label>Token</Label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="64 hex characters"
          className="font-mono text-xs"
          autoFocus
        />
        {error && <p className="mt-2 text-xs text-err">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" disabled={!value.trim() || busy} onClick={() => void submit()}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
