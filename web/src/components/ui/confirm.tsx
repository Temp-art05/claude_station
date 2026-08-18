import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

export interface ConfirmOptions {
  title: string;
  /** The consequence, in one or two lines. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything that destroys work — deletes, discards, force pushes. */
  tone?: "default" | "danger";
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * Promise-based confirm, so the call sites keep reading like the `window.confirm`
 * they replaced:
 *
 *     if (await confirm({ title: "Delete agent?" })) del.mutate(id);
 *
 * The browser's own dialog is a white OS sheet titled "claude.station says",
 * blocks the whole tab, and can be permanently suppressed by the user — which
 * would silently turn every guarded action into an unguarded one.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: Resolver } | null>(
    null,
  );

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          // Two prompts at once would strand the first caller's promise.
          current?.resolve(false);
          return { options, resolve };
        });
      }),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onClose={() => settle(false)}
        title={pending?.options.title ?? ""}
        className="max-w-md"
      >
        {pending?.options.body && (
          <div className="m3-body-md text-ink-muted">{pending.options.body}</div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(false)}>
            {pending?.options.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={pending?.options.tone === "danger" ? "danger" : "primary"}
            onClick={() => settle(true)}
            autoFocus
          >
            {pending?.options.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return confirm;
}
