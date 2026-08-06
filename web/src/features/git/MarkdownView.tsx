import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Rendered markdown preview for .md files. Sanitized because repo files are
 * still untrusted input to THIS app (a script tag in a README must not run
 * with access to the station token).
 */
export function MarkdownView({ source }: { source: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true })),
    [source],
  );

  return (
    <div className="h-full overflow-y-auto bg-base">
      <div
        className={[
          "mx-auto max-w-3xl px-8 py-6 text-[13.5px] leading-relaxed text-ink",
          // Headings
          "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-hairline [&_h1]:pb-2 [&_h1]:text-xl [&_h1]:font-semibold",
          "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
          "[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold",
          "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold",
          // Text blocks
          "[&_p]:my-2.5",
          "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
          "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted",
          "[&_hr]:my-5 [&_hr]:border-hairline",
          // Lists
          "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5",
          // Code
          "[&_code]:rounded [&_code]:bg-white/8 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]",
          "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-hairline [&_pre]:bg-surface-2 [&_pre]:p-3",
          "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
          // Tables
          "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12.5px]",
          "[&_th]:border [&_th]:border-hairline [&_th]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
          "[&_td]:border [&_td]:border-hairline [&_td]:px-2.5 [&_td]:py-1.5",
          // Images
          "[&_img]:max-w-full [&_img]:rounded-md",
        ].join(" ")}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
