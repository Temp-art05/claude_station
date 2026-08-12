import { Undo2 } from "lucide-react";

/**
 * Shown when an editor opens on unsaved changes recovered from a previous
 * visit. Restoring silently would be worse than losing the draft: the record
 * may have changed server-side in the meantime, and saving over it without
 * warning looks like someone else's work vanishing.
 */
export function DraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
      <span className="min-w-0 flex-1">
        Restored unsaved changes from your last visit — they may be older than the saved version.
      </span>
      <button
        type="button"
        onClick={onDiscard}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-medium hover:bg-warn/15"
      >
        <Undo2 size={11} /> Discard
      </button>
    </div>
  );
}
