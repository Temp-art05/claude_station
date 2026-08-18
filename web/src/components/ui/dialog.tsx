import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "./icons";
import { cn } from "@/lib/utils";
import { IconButton } from "./button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

/** M3 dialog: 28px shape, dimmed scrim, and an emphasized-decelerate entrance. */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="animate-scrim-in absolute inset-0 bg-black/45 backdrop-blur-md"
        onClick={onClose}
      />
      <div
        className={cn(
          "liquid-raised animate-dialog-in relative w-full max-w-lg rounded-2xl",
          "flex max-h-[85vh] flex-col",
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-6 py-4">
          <h2 className="m3-title-lg">{title}</h2>
          <IconButton onClick={onClose} aria-label="Close" dense>
            <X size={18} />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
