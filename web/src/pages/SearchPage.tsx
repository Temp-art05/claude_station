import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { Badge, Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface Hits {
  chat: {
    messageId: string;
    sessionId: string;
    sessionTitle: string;
    projectId: string;
    seq: number;
    snippet: string;
  }[];
  knowledge: {
    itemId: string;
    name: string;
    projectId: string | null;
    itemKind: string;
    snippet: string;
  }[];
}

/** FTS5 wraps matches in « » — render those as highlights. */
function Snippet({ text }: { text: string }) {
  return (
    <p className="text-xs leading-relaxed text-ink-muted">
      {text.split(/(«[^»]*»)/).map((part, i) =>
        part.startsWith("«") ? (
          <mark key={i} className="bg-accent/25 text-ink">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

export function SearchPage() {
  const [term, setTerm] = useState("");
  const trimmed = term.trim();

  const { data, isFetching } = useQuery({
    queryKey: ["search", trimmed],
    queryFn: () => api.get<Hits>(`/api/search?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length >= 2,
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="mb-3 text-lg font-semibold">Search</h1>
      <div className="relative mb-5">
        <Search size={15} className="absolute left-3 top-2.5 text-ink-faint" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search chat history and imported knowledge…"
          className="pl-9"
          autoFocus
        />
      </div>

      {trimmed.length >= 2 && isFetching && <p className="text-sm text-ink-muted">Searching…</p>}

      {data && (
        <>
          {data.chat.length === 0 && data.knowledge.length === 0 && (
            <p className="text-sm text-ink-muted">No matches.</p>
          )}

          {data.chat.length > 0 && (
            <section className="mb-5">
              <h2 className="mb-2 text-xs font-medium text-ink-faint">Chat</h2>
              <div className="space-y-2">
                {data.chat.map((hit) => (
                  <Link key={hit.messageId} to={`/projects/${hit.projectId}`}>
                    <Card className="hover:border-edge-strong hover:bg-surface-2">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-xs font-medium">{hit.sessionTitle}</span>
                        <Badge>#{hit.seq}</Badge>
                      </div>
                      <Snippet text={hit.snippet} />
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {data.knowledge.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium text-ink-faint">Knowledge</h2>
              <div className="space-y-2">
                {data.knowledge.map((hit) => (
                  <Card key={hit.itemId}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-medium">{hit.name}</span>
                      <Badge>{hit.itemKind}</Badge>
                      {hit.projectId === null && <Badge tone="accent">global</Badge>}
                    </div>
                    <Snippet text={hit.snippet} />
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
