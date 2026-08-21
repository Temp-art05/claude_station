import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Select } from "@/components/ui/select";
import { FileDown, FileUp, KeyRound, Plus, Trash2 } from "@/components/ui/icons";
import type { EnvSet, EnvSetInput, Project } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type VarDraft = { key: string; value: string; isSecret: boolean };

/** Keys that smell like credentials get the secret flag on import. */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|_PAT\b|_KEY\b|APIKEY|AUTH|CREDENTIAL/i;

/** Parse .env text: KEY=VALUE lines, quotes stripped, comments skipped. */
function parseDotEnv(text: string): VarDraft[] {
  const out: VarDraft[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // Double quotes carry escapes, the way dotenv writes them — and the way
      // `toDotEnv` below emits any value that needs quoting.
      value = value
        .slice(1, -1)
        .replace(/\\([\\"nrt])/g, (_, c: string) =>
          c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
        );
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out.push({ key: m[1]!, value, isSecret: SECRET_KEY.test(m[1]!) });
  }
  return out;
}

/** Values that would not survive `parseDotEnv` unquoted get double-quoted. */
function quoteIfNeeded(value: string): string {
  if (!/[\s"'#\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Serialise vars back to .env text. Secrets go out in clear — the DB holds
 *  them that way too, and a masked export would be useless as a .env file. */
function toDotEnv(set: Pick<EnvSet, "name" | "description">, vars: VarDraft[]): string {
  const header = [`# ${set.name}`, set.description ? `# ${set.description}` : null].filter(Boolean);
  const lines = vars
    .filter((v) => v.key.trim())
    .map((v) => `${v.key.trim()}=${quoteIfNeeded(v.value)}`);
  return [...header, "", ...lines, ""].join("\n");
}

/** Hand the .env text to the browser as a download named after the set. */
function downloadDotEnv(name: string, text: string) {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug || "env-set"}.env`;
  a.click();
  URL.revokeObjectURL(url);
}

export function EnvPage() {
  const qc = useQueryClient();
  const { data: sets = [] } = useQuery({
    queryKey: ["env-sets"],
    queryFn: () => api.get<EnvSet[]>("/api/env-sets"),
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
  });

  const save = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: EnvSetInput }) =>
      id
        ? api.patch<EnvSet>(`/api/env-sets/${id}`, input)
        : api.post<EnvSet>("/api/env-sets", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["env-sets"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/env-sets/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["env-sets"] }),
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [vars, setVars] = useState<VarDraft[]>([{ key: "", value: "", isSecret: false }]);
  const envFileRef = useRef<HTMLInputElement | null>(null);

  const startNew = () => {
    setEditing("new");
    setName("");
    setDescription("");
    setProjectId("");
    setSharedWith([]);
    setVars([{ key: "", value: "", isSecret: false }]);
  };

  const startEdit = (set: EnvSet) => {
    setEditing(set.id);
    setName(set.name);
    setDescription(set.description ?? "");
    setProjectId(set.projectId ?? "");
    setSharedWith(set.sharedWith ?? []);
    setVars(
      set.vars.length
        ? set.vars.map((v) => ({ key: v.key, value: v.value, isSecret: v.isSecret }))
        : [{ key: "", value: "", isSecret: false }],
    );
  };

  /** Merge an imported .env into the draft: same key updates, new keys append. */
  const importEnvFile = async (file: File) => {
    const parsed = parseDotEnv(await file.text());
    if (parsed.length === 0) return;
    setVars((prev) => {
      const existing = prev.filter((v) => v.key.trim());
      const byKey = new Map(existing.map((v) => [v.key, v] as const));
      for (const v of parsed) {
        const current = byKey.get(v.key);
        if (current) {
          current.value = v.value;
        } else {
          const row = { ...v };
          existing.push(row);
          byKey.set(v.key, row);
        }
      }
      return [...existing];
    });
    if (!name.trim()) setName(file.name === ".env" ? "imported .env" : file.name);
  };

  const submit = () => {
    const input: EnvSetInput = {
      name: name.trim(),
      description: description.trim(),
      projectId: projectId || null,
      vars: vars.filter((v) => v.key.trim()),
      // A global set is already everywhere; keeping stale shares would just
      // resurrect them if the scope is narrowed again later.
      sharedWith: projectId ? sharedWith.filter((id) => id !== projectId) : [],
    };
    save.mutate(
      { id: editing === "new" ? undefined : (editing ?? undefined), input },
      { onSuccess: () => setEditing(null) },
    );
  };

  const editorCard = (
    <Card className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Staging" />
        </div>
        <div className="w-56">
          <Label>Scope</Label>
          <Select
            size="md"
            className="w-full"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: "", label: "Global (all projects)" },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
      </div>

      <div>
        <Label>Also available in</Label>
        {projectId ? (
          <div className="flex flex-wrap gap-1.5">
            {projects
              .filter((p) => p.id !== projectId)
              .map((p) => {
                const on = sharedWith.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() =>
                      setSharedWith((prev) =>
                        on ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                      )
                    }
                    className={cn(
                      "cursor-pointer rounded-pill border px-2.5 py-1 text-xs transition-colors",
                      on
                        ? "border-accent/30 bg-accent/12 text-accent"
                        : "border-hairline bg-white/6 text-ink-muted hover:text-ink",
                    )}
                  >
                    {p.name}
                  </button>
                );
              })}
            {projects.length < 2 && (
              <p className="text-xs text-ink-faint">No other project to share with yet.</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-ink-faint">
            A global set already reaches every project — pick an owner above to share it selectively
            instead.
          </p>
        )}
      </div>

      <div>
        <Label>Description (what is this set for?)</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="jira-ai-fixer config cho project WIS555 — đè JIRA_PROJECT_KEY, CODE_REPO"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label className="mb-0">Variables</Label>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => envFileRef.current?.click()}
              title="Parse a .env file — existing keys get updated, new keys appended"
            >
              <FileUp size={16} /> Import .env
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                downloadDotEnv(name || "env-set", toDotEnv({ name, description }, vars))
              }
              disabled={!vars.some((v) => v.key.trim())}
              title="Download the variables below as a .env file"
            >
              <FileDown size={16} /> Export .env
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setVars((v) => [...v, { key: "", value: "", isSecret: false }])}
            >
              <Plus size={16} /> Add
            </Button>
          </div>
          <input
            ref={envFileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importEnvFile(file);
              e.target.value = "";
            }}
          />
        </div>
        <div className="space-y-2">
          {vars.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="w-56 font-mono text-xs"
                value={v.key}
                onChange={(e) =>
                  setVars((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                  )
                }
                placeholder="API_BASE_URL"
              />
              <Input
                className="font-mono text-xs"
                value={v.value}
                onChange={(e) =>
                  setVars((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  )
                }
                placeholder="value"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={v.isSecret}
                  onChange={(e) =>
                    setVars((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, isSecret: e.target.checked } : x)),
                    )
                  }
                  className="accent-(--color-accent)"
                />
                secret
              </label>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setVars((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove var"
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={!name.trim() || save.isPending}>
          Save
        </Button>
      </div>
    </Card>
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <PageHeader
        title="Environment sets"
        icon={KeyRound}
        supporting="Injected into terminals, build commands, and Claude sessions. Stored in plain text in the local DB."
        actions={
          <Button variant="primary" onClick={startNew}>
            <Plus size={18} /> New set
          </Button>
        }
      />

      <div className="space-y-2">
        {editing === "new" && editorCard}
        {sets.map((set) =>
          editing === set.id ? (
            <div key={set.id}>{editorCard}</div>
          ) : (
            <Card key={set.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="m3-title-sm font-bold text-ok">{set.name}</span>
                  <Badge tone={set.projectId ? "default" : "accent"}>
                    {set.projectId
                      ? (projects.find((p) => p.id === set.projectId)?.name ?? "project")
                      : "global"}
                  </Badge>
                  {set.sharedWith.map((pid) => (
                    <Badge key={pid} tone="accent" title="Shared into this project">
                      +{projects.find((p) => p.id === pid)?.name ?? "project"}
                    </Badge>
                  ))}
                  <Badge>{set.vars.length} vars</Badge>
                </div>
                {set.description && <p className="mt-1 m3-body-sm text-white">{set.description}</p>}
                <div className="mt-1.5 line-clamp-2 font-mono m3-label-md leading-5 text-white">
                  {set.vars.map((v) => (
                    <span key={v.id} className="mr-3">
                      {v.key}={v.isSecret ? "••••••" : v.value || "″″"}
                    </span>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => downloadDotEnv(set.name, toDotEnv(set, set.vars))}
                disabled={set.vars.length === 0}
                title="Download this set as a .env file"
              >
                <FileDown size={16} /> Export
              </Button>
              <Button size="sm" variant="ghost" onClick={() => startEdit(set)}>
                Edit
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => remove.mutate(set.id)}
                aria-label="Delete"
              >
                <Trash2 size={16} />
              </Button>
            </Card>
          ),
        )}
        {sets.length === 0 && (
          <Card className="py-10 text-center text-sm text-ink-muted">No env sets yet.</Card>
        )}
      </div>
    </div>
  );
}
