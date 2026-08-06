import { useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { hasToken, setToken } from "@/lib/token";

/**
 * The API refuses every request without the shared token. Normally it arrives
 * via the `?t=` link the server prints; this is the manual fallback.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(hasToken());
  const [value, setValue] = useState("");

  if (ready) return <>{children}</>;

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
          placeholder="64 hex characters"
          className="font-mono text-xs"
          autoFocus
        />
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!value.trim()}
            onClick={() => {
              setToken(value);
              setReady(true);
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
