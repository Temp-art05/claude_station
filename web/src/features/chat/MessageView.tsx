import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatEntry } from "./useChatSocket";

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function blocksOf(message: unknown): Block[] {
  const raw = message as { message?: { content?: unknown }; content?: unknown };
  const content = raw.message?.content ?? raw.content;
  if (Array.isArray(content)) return content as Block[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** Raw JSON stays one click away — the SDK adds message types faster than any UI. */
function RawToggle({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(!open)}
        className="cursor-pointer text-[10.5px] text-ink-faint hover:text-ink-muted"
      >
        {open ? "hide raw" : "raw"}
      </button>
      {open && (
        <pre className="scroll-x mt-1 max-h-64 overflow-auto rounded-md bg-base p-2 font-mono text-[10.5px] text-ink-faint">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolUseCard({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-edge bg-surface">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Wrench size={12} className="shrink-0 text-accent" />
        <span className="font-mono text-[11.5px]">{block.name}</span>
        <ChevronRight
          size={12}
          className={cn("ml-auto text-ink-faint transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <pre className="scroll-x max-h-72 overflow-auto border-t border-edge px-2.5 py-2 font-mono text-[10.5px] text-ink-muted">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function MessageView({ entry }: { entry: ChatEntry }) {
  const message = entry.message as { type?: string; text?: string; subtype?: string };

  if (message.type === "user_input") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-surface-3 px-3 py-2 text-sm">
          {message.text}
        </div>
      </div>
    );
  }

  if (message.type === "result") {
    return null; // rendered as the footer strip instead
  }

  if (message.type === "system") {
    return (
      <p className="text-[11px] text-ink-faint">
        session {message.subtype === "init" ? "started" : (message.subtype ?? "")}
      </p>
    );
  }

  const blocks = blocksOf(entry.message);
  if (blocks.length === 0) {
    return (
      <div className="text-[11px] text-ink-faint">
        {message.type}
        <RawToggle value={entry.message} />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {blocks.map((block, i) => {
        if (block.type === "text") {
          return (
            <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
              {block.text}
            </p>
          );
        }
        if (block.type === "thinking") {
          return (
            <p key={i} className="border-l-2 border-think/40 pl-2.5 text-xs italic text-think/80">
              {block.thinking || "thinking…"}
            </p>
          );
        }
        if (block.type === "tool_use") return <ToolUseCard key={i} block={block} />;
        if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content, null, 2);
          return (
            <pre
              key={i}
              className={cn(
                "scroll-x max-h-52 overflow-auto rounded-md px-2.5 py-1.5 font-mono text-[10.5px]",
                block.is_error ? "bg-err/10 text-err" : "bg-base text-ink-faint",
              )}
            >
              {text?.slice(0, 4000)}
            </pre>
          );
        }
        return (
          <div key={i} className="text-[11px] text-ink-faint">
            {block.type}
            <RawToggle value={block} />
          </div>
        );
      })}
    </div>
  );
}
