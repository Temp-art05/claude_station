import { Undo2 } from "@/components/ui/icons";

/**
 * Shown when an editor opens on unsaved changes recovered from a previous
 * visit. Restoring silently would be worse than losing the draft: the record
 * may have changed server-side in the meantime, and saving over it without
 * warning looks like someone else's work vanishing.
 */
export function DraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div className="m3-body-sm flex items-center gap-2 rounded-lg bg-warn/14 px-3.5 py-2 text-warn">
      <span className="min-w-0 flex-1">
        Restored unsaved changes from your last visit — they may be older than the saved version.
      </span>
      <button
        type="button"
        onClick={onDiscard}
        className="state-layer inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-pill px-2.5 py-1 font-semibold"
      >
        <Undo2 size={16} /> Discard
      </button>
    </div>
  );
}
