import { useState } from "react";
import { ChevronRight, Wrench } from "@/components/ui/icons";
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
        className="cursor-pointer m3-label-sm text-ink-faint hover:text-ink-muted"
      >
        {open ? "hide raw" : "raw"}
      </button>
      {open && (
        <pre className="scroll-x m3-label-sm mt-1.5 max-h-64 overflow-auto rounded-lg bg-surface-container-lowest/70 p-3 font-mono text-ink-faint">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolUseCard({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="liquid rounded-lg">
      <button
        onClick={() => setOpen(!open)}
        className="state-layer flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left"
      >
        <Wrench size={18} className="shrink-0 text-primary" />
        <span className="font-mono m3-label-md">{block.name}</span>
        <ChevronRight
          size={16}
          className={cn("ml-auto text-ink-faint transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <pre className="scroll-x m3-label-sm max-h-72 overflow-auto border-t border-hairline px-3.5 py-3 font-mono text-ink-muted">
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
        <div className="m3-body-md max-w-[80%] rounded-xl rounded-br-sm bg-primary-container/50 px-3.5 py-2.5 whitespace-pre-wrap text-on-primary-container">
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
      <p className="m3-label-sm text-ink-faint">
        session {message.subtype === "init" ? "started" : (message.subtype ?? "")}
      </p>
    );
  }

  const blocks = blocksOf(entry.message);
  if (blocks.length === 0) {
    return (
      <div className="m3-label-sm text-ink-faint">
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
            <p key={i} className="m3-body-md whitespace-pre-wrap leading-relaxed">
              {block.text}
            </p>
          );
        }
        if (block.type === "thinking") {
          return (
            <p
              key={i}
              className="m3-body-sm border-l-2 border-tertiary/40 pl-3 text-tertiary/85 italic"
            >
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
                "scroll-x max-h-52 overflow-auto rounded-md px-2.5 py-1.5 font-mono m3-label-sm",
                block.is_error ? "bg-err/10 text-err" : "bg-base text-ink-faint",
              )}
            >
              {text?.slice(0, 4000)}
            </pre>
          );
        }
        return (
          <div key={i} className="m3-label-sm text-ink-faint">
            {block.type}
            <RawToggle value={block} />
          </div>
        );
      })}
    </div>
  );
}
