import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { cn } from "@/lib/utils";

/**
 * GitHub's own prose styling, as Tailwind arbitrary-variant selectors. Shared so
 * a README preview and a PR description render identically instead of drifting.
 */
const PROSE = [
  "m3-body-md leading-[1.65] text-ink",
  // Headings
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-hairline [&_h1]:pb-2 [&_h1]:text-xl [&_h1]:font-semibold",
  "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-hairline [&_h2]:pb-1.5 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold",
  // Text blocks — first/last margins collapse so the prose sits flush in a card
  "[&_p]:my-2.5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_strong]:font-semibold [&_strong]:text-ink",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-edge-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted",
  "[&_hr]:my-5 [&_hr]:border-hairline",
  // Lists
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5",
  // GFM task lists: the checkbox replaces the bullet, as on GitHub
  "[&_li:has(>input[type=checkbox])]:list-none [&_li:has(>input[type=checkbox])]:-ml-5",
  "[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:align-middle",
  // Code
  "[&_code]:rounded [&_code]:bg-white/8 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:m3-label-md",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-hairline [&_pre]:bg-surface-2 [&_pre]:p-3 [&_pre]:m3-label-md [&_pre]:leading-relaxed",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  // Tables — wide ones scroll rather than blowing out the card
  "[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:m3-body-sm",
  "[&_th]:border [&_th]:border-hairline [&_th]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-hairline [&_td]:px-2.5 [&_td]:py-1.5",
  // Images
  "[&_img]:max-w-full [&_img]:rounded-md",
].join(" ");

/**
 * Rendered markdown. Sanitized because both repo files and PR bodies are
 * untrusted input to THIS app (a script tag must not run with access to the
 * station token).
 *
 * `breaks` mirrors GitHub's split behaviour: comment and PR-description fields
 * turn a lone newline into a line break, plain `.md` files do not.
 */
export function MarkdownBody({
  source,
  breaks = false,
  className,
}: {
  source: string;
  breaks?: boolean;
  className?: string;
}) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks })),
    [source, breaks],
  );
  return <div className={cn(PROSE, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Full-pane preview for a `.md` file in the repo browser. */
export function MarkdownView({ source }: { source: string }) {
  return (
    <div className="h-full overflow-y-auto bg-base">
      <MarkdownBody source={source} className="mx-auto max-w-3xl px-8 py-6" />
    </div>
  );
}
