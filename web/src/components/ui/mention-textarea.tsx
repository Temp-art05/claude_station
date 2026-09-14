/**
 * A textarea where `@` reaches the things this workspace already knows about.
 *
 * The picker is the small half of the feature. The half that matters happens on
 * the server: a tag left in the text is resolved before the step runs, so the
 * agent is handed the ticket and the spec rather than a pointer to them. What
 * this component owes that is a token in the exact shape the resolver expects —
 * hence inserting `@jira:KEY` rather than a pretty label.
 *
 * Documents are pasted as GitHub links rather than picked: browsing a repo tree
 * in a dropdown is a lot of machinery to replace a Cmd-V, and the server accepts
 * the pasted URL as-is.
 */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Suggestion {
  token: string;
  label: string;
  hint: string;
}

interface JiraIssue {
  key: string;
  summary: string;
}

interface GithubConfig {
  repos: string[];
}

export function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  /** The `@word` being typed right now, or null when the caret is elsewhere. */
  const [query, setQuery] = useState<{ text: string; from: number; to: number } | null>(null);
  const [active, setActive] = useState(0);

  const { data: projects = [] } = useQuery({
    queryKey: ["jira-projects-pinned"],
    queryFn: () => api.get<string[]>("/api/jira/projects/pinned"),
    staleTime: 5 * 60_000,
  });
  const { data: github } = useQuery({
    queryKey: ["github-repos"],
    // Not /api/integrations/github — that one wraps the config and hides the
    // token, so `repos` would come back undefined and the picker would quietly
    // offer no repos at all.
    queryFn: () => api.get<GithubConfig>("/api/github/repos"),
    staleTime: 5 * 60_000,
  });

  // Tickets are searched rather than listed: nobody scrolls to their ticket.
  const term = query?.text ?? "";
  const { data: issues = [] } = useQuery({
    queryKey: ["jira-mention", term],
    queryFn: () => api.get<JiraIssue[]>(`/api/jira/issues?jql=${encodeURIComponent(term)}&limit=6`),
    enabled: term.length >= 3,
    staleTime: 60_000,
  });

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(q);
    const out: Suggestion[] = [];
    for (const key of projects) {
      if (q && !match(key)) continue;
      out.push({ token: `@jira:${key}`, label: key, hint: "Jira project" });
    }
    for (const issue of issues) {
      out.push({ token: `@ticket:${issue.key}`, label: issue.key, hint: issue.summary });
    }
    for (const repo of github?.repos ?? []) {
      if (q && !match(repo)) continue;
      out.push({ token: `@repo:${repo}`, label: repo, hint: "GitHub repo" });
    }
    return out.slice(0, 8);
  }, [query, projects, issues, github]);

  // Keeping the highlight in range without an effect: the list is recomputed on
  // every keystroke, so a stored index would be stale as often as it is right.
  const activeIndex = suggestions.length === 0 ? 0 : active % suggestions.length;

  /** Find the `@…` the caret sits in, if any. */
  function refreshQuery(el: HTMLTextAreaElement): void {
    const caret = el.selectionStart;
    const upto = el.value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0) return setQuery(null);
    const word = upto.slice(at + 1);
    // A space ends it, and so does a token that already carries its prefix.
    if (/\s/.test(word) || word.includes(":")) return setQuery(null);
    setQuery({ text: word, from: at, to: caret });
  }

  function insert(token: string): void {
    if (!query) return;
    const next = `${value.slice(0, query.from)}${token} ${value.slice(query.to)}`;
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const caret = query.from + token.length + 1;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  const open = query !== null && suggestions.length > 0;

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={rows}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          refreshQuery(e.target);
        }}
        onClick={(e) => refreshQuery(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % suggestions.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            insert(suggestions[activeIndex]!.token);
          } else if (e.key === "Escape") {
            setQuery(null);
          }
        }}
        className={cn(
          "w-full rounded-md border border-outline/45 bg-white/3 px-3.5 py-2 text-sm text-ink transition-[border-color,background-color] duration-200 ease-emphasized placeholder:text-ink-faint hover:border-outline/80 focus:border-primary focus:outline-none",
          className,
        )}
      />
      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-hairline bg-surface shadow-lg">
          {suggestions.map((s, i) => (
            <button
              key={s.token}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(s.token)}
              className={cn(
                "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                i === activeIndex ? "bg-accent/15" : "hover:bg-white/5",
              )}
            >
              <span className="font-mono">{s.label}</span>
              <span className="min-w-0 flex-1 truncate m3-label-sm text-ink-faint">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-1 m3-label-sm text-ink-faint">
        Type <span className="font-mono">@</span> for a Jira project, ticket or repo. Paste a GitHub
        file link and its contents are read for you before the first step runs.
      </p>
    </div>
  );
}
