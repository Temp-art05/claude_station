/**
 * Packs: a repo's worth of skills, agents and workflows, installed as a set.
 *
 * The screen is built around the thing that matters — you see exactly what would
 * be registered, and choose, before anything is. A pack ends up inside prompts;
 * "trust me, install it" is not a flow this app offers.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/page-header";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import {
  Bot,
  Download,
  Library,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Workflow,
} from "@/components/ui/icons";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type AssetKind = "skill" | "agent" | "workflow" | "script";

interface ScannedAsset {
  kind: AssetKind;
  relPath: string;
  name: string;
  files?: string[];
  warning?: string;
}

interface Preview {
  name: string;
  repoUrl: string;
  ref: string;
  sha: string;
  assets: ScannedAsset[];
  stagedPath: string;
  readme: string;
}

interface PackAsset {
  id: string;
  kind: AssetKind;
  relPath: string;
  name: string;
  status: string;
}

interface Pack {
  id: string;
  name: string;
  repoUrl: string;
  ref: string;
  sha: string;
  installedAt: string;
  assets: PackAsset[];
}

const KIND_ICON = { skill: Library, agent: Bot, workflow: Workflow, script: TriangleAlert };

export function PacksPage() {
  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto py-6">
      <div className="px-6">
        <PageHeader
          title="Packs"
          supporting="Install a repo of skills, agents and workflows as one set — pinned to a commit, and only after you have seen what is in it."
          icon={Library}
        />
      </div>
      <div className="space-y-4 px-6 pb-10">
        <InstallCard />
        <InstalledList />
      </div>
    </div>
  );
}

function InstallCard() {
  const qc = useQueryClient();
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const doPreview = useMutation({
    mutationFn: () =>
      api.post<Preview>("/api/packs/preview", { repoUrl, ref: ref.trim() || "HEAD" }),
    onSuccess: (result) => {
      setPreview(result);
      setError(null);
      // Everything installable is pre-selected; scripts never are, and cannot be.
      setChosen(new Set(result.assets.filter((a) => a.kind !== "script").map((a) => a.relPath)));
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not read that repo"),
  });

  const install = useMutation({
    mutationFn: () => api.post("/api/packs", { ...preview, relPaths: [...chosen] }),
    onSuccess: () => {
      setPreview(null);
      setRepoUrl("");
      qc.invalidateQueries({ queryKey: ["packs"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Install failed"),
  });

  const discard = useMutation({
    mutationFn: () => api.post("/api/packs/discard", { stagedPath: preview?.stagedPath }),
    onSuccess: () => setPreview(null),
  });

  return (
    <Card className="space-y-3">
      <h2 className="m3-title-sm">Install a pack</h2>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Label>Repo URL</Label>
          <Input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/name"
            className="font-mono text-xs"
          />
        </div>
        <div className="w-40">
          <Label>Branch or tag</Label>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="HEAD" />
        </div>
        <Button
          variant="secondary"
          disabled={!repoUrl.trim() || doPreview.isPending}
          onClick={() => doPreview.mutate()}
        >
          <Download size={16} />
          {doPreview.isPending ? "Cloning…" : "Preview"}
        </Button>
      </div>
      {error && <p className="m3-body-sm text-err">{error}</p>}

      {preview && (
        <div className="space-y-3 border-t border-hairline pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="m3-title-sm">{preview.name}</p>
            <span className="m3-label-sm font-mono text-ink-faint">{preview.sha.slice(0, 10)}</span>
          </div>

          {preview.assets.length === 0 ? (
            <p className="m3-body-sm text-ink-muted">
              Nothing installable found. A pack keeps skills in a directory with a{" "}
              <code className="font-mono">SKILL.md</code>, agents in{" "}
              <code className="font-mono">agents/</code>, workflows in{" "}
              <code className="font-mono">workflows/</code>.
            </p>
          ) : (
            <div className="space-y-1">
              {preview.assets.map((asset) => {
                const Icon = KIND_ICON[asset.kind];
                const installable = asset.kind !== "script";
                return (
                  <label
                    key={asset.relPath}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5",
                      installable ? "cursor-pointer hover:bg-white/4" : "opacity-70",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-(--color-accent)"
                      disabled={!installable}
                      checked={chosen.has(asset.relPath)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(asset.relPath);
                        else next.delete(asset.relPath);
                        setChosen(next);
                      }}
                    />
                    <Icon size={16} className="shrink-0 text-ink-faint" />
                    <span className="m3-label-md w-20 shrink-0 text-ink-faint">{asset.kind}</span>
                    <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                    {asset.warning && (
                      <span className="m3-label-sm shrink-0 text-warn">{asset.warning}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              disabled={chosen.size === 0 || install.isPending}
              onClick={() => install.mutate()}
            >
              {install.isPending
                ? "Installing…"
                : `Install ${chosen.size} asset${chosen.size === 1 ? "" : "s"}`}
            </Button>
            <Button
              variant="ghost"
              disabled={install.isPending || discard.isPending}
              onClick={() => discard.mutate()}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

interface UpdateOutcome {
  status: "current" | "updated";
  sha: string;
  from?: string;
  installed?: PackAsset[];
}

function InstalledList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: packs = [] } = useQuery({
    queryKey: ["packs"],
    queryFn: () => api.get<Pack[]>("/api/packs"),
  });

  /**
   * One line per pack saying how its last check went.
   *
   * Checking for updates is a network round trip that usually ends in "nothing
   * changed", and without this the button spun up, did the work, and left the
   * screen identical — indistinguishable from a button that does nothing.
   */
  const [note, setNote] = useState<Record<string, { text: string; tone: "ok" | "err" }>>({});
  const say = (id: string, text: string, tone: "ok" | "err" = "ok") =>
    setNote((prev) => ({ ...prev, [id]: { text, tone } }));

  const update = useMutation({
    mutationFn: (id: string) => api.post<UpdateOutcome>(`/api/packs/${id}/update`),
    onSuccess: (outcome, id) => {
      qc.invalidateQueries({ queryKey: ["packs"] });
      say(
        id,
        outcome.status === "current"
          ? `Already on the latest commit (${outcome.sha.slice(0, 7)})`
          : `Updated to ${outcome.sha.slice(0, 7)} — ${outcome.installed?.length ?? 0} asset(s) re-registered`,
      );
    },
    onError: (err, id) => say(id, err instanceof Error ? err.message : "Update failed", "err"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/packs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["packs"] }),
    onError: (err, id) => say(id, err instanceof Error ? err.message : "Uninstall failed", "err"),
  });

  if (packs.length === 0) {
    return <p className="m3-body-sm text-ink-faint">No pack installed yet.</p>;
  }

  return (
    <div className="space-y-3">
      {packs.map((pack) => {
        const updating = update.isPending && update.variables === pack.id;
        const removing = remove.isPending && remove.variables === pack.id;
        const busy = updating || removing;
        return (
          <Card key={pack.id} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="m3-title-sm truncate">{pack.name}</p>
                <p className="m3-label-sm truncate text-ink-faint">
                  {pack.repoUrl} · {pack.ref} ·{" "}
                  <span className="font-mono">{pack.sha.slice(0, 10)}</span>
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  title="Check the remote for a newer commit"
                  disabled={busy}
                  onClick={() => {
                    say(pack.id, "Checking the remote…");
                    update.mutate(pack.id);
                  }}
                >
                  <RefreshCw size={16} className={cn(updating && "animate-spin")} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Uninstall this pack"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Uninstall ${pack.name}?`,
                      body: "Everything this pack registered is removed — skills, agents and workflows it added. Anything you created yourself stays.",
                      confirmLabel: "Uninstall",
                      tone: "danger",
                    });
                    if (ok) remove.mutate(pack.id);
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pack.assets.map((asset) => (
                <Badge
                  key={asset.id}
                  tone={
                    asset.status === "installed"
                      ? "default"
                      : asset.status === "conflict"
                        ? "err"
                        : "warn"
                  }
                >
                  {asset.kind}: {asset.name}
                </Badge>
              ))}
            </div>
            {note[pack.id] && (
              <p
                className={cn(
                  "m3-label-sm",
                  note[pack.id]!.tone === "err" ? "text-err" : "text-ink-faint",
                )}
              >
                {note[pack.id]!.text}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
