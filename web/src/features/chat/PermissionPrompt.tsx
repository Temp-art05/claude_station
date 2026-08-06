import { useEffect, useState } from "react";
import { ShieldQuestionMark } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PermissionRequest } from "./useChatSocket";

interface Props {
  request: PermissionRequest;
  onRespond: (requestId: string, behavior: "allow" | "deny", message?: string) => void;
}

/**
 * Claude blocks until this is answered. The countdown mirrors the server-side
 * timeout, which auto-denies — so the UI never claims more time than it has.
 */
export function PermissionPrompt({ request, onRespond }: Props) {
  // Mounted with key={requestId}, so the countdown starts fresh per request.
  const [left, setLeft] = useState(request.timeoutSec);

  useEffect(() => {
    const timer = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="border-t border-warn/30 bg-warn/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldQuestionMark size={14} className="text-warn" />
        <span className="text-sm font-medium">
          Allow <code className="font-mono">{request.toolName}</code>?
        </span>
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          auto-deny in {left}s
        </span>
      </div>
      <pre className="scroll-x mb-2.5 max-h-40 overflow-auto rounded-md bg-base px-2.5 py-2 font-mono text-[10.5px] text-ink-muted">
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => onRespond(request.requestId, "allow")}>
          Allow
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => onRespond(request.requestId, "deny", "Denied by the user.")}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
