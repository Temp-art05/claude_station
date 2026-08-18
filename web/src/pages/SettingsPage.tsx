import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  Download,
  RotateCcw,
  Settings as SettingsIcon,
  Upload,
} from "@/components/ui/icons";
import { normalizeGithubRepo, type AppSettings } from "@claude-station/shared";
import { useConfirm } from "@/components/ui/confirm";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api";
import { resetUiState } from "@/lib/uiStore";
import { fileUrl, uploadFile } from "@/lib/upload";

interface Doctor {
  node: string;
  repoRoot: string;
  dataDir: string;
  dataDirWritable: boolean;
  skillsLinkDir: string;
  port: number;
  sdkVersion: string;
  claudeCli: { ok: boolean; detail: string };
  gh: { ok: boolean; detail: string };
  git: { ok: boolean; detail: string };
  pty: { ok: boolean; detail: string };
  runningTerminals: number;
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 py-1">
      {ok ? (
        <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" />
      ) : (
        <CircleAlert size={16} className="mt-0.5 shrink-0 text-err" />
      )}
      <div className="min-w-0">
        <span className="text-sm">{label}</span>
        {detail && (
          <p className="truncate font-mono m3-label-sm text-ink-faint" title={detail}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: doctor } = useQuery({
    queryKey: ["doctor"],
    queryFn: () => api.get<Doctor>("/api/doctor"),
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSettings>("/api/settings"),
  });
  const update = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.patch<AppSettings>("/api/settings", patch),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <PageHeader
        title="Settings"
        icon={SettingsIcon}
        supporting={
          <>
            Behaviour lives in the local DB and applies immediately. Ports and data paths come from{" "}
            <code className="font-mono">.env</code>.
          </>
        }
      />

      <Card className="mb-4">
        <h2 className="m3-title-sm mb-2">Doctor</h2>
        {!doctor && <p className="text-sm text-ink-muted">Checking…</p>}
        {doctor && (
          <>
            <Check ok={doctor.pty.ok} label="node-pty (terminals)" detail={doctor.pty.detail} />
            <Check ok={doctor.claudeCli.ok} label="claude CLI" detail={doctor.claudeCli.detail} />
            <Check ok={doctor.gh.ok} label="gh CLI login" detail={doctor.gh.detail} />
            <Check ok={doctor.git.ok} label="git" detail={doctor.git.detail} />
            <Check ok={doctor.dataDirWritable} label="data dir writable" detail={doctor.dataDir} />
            <div className="m3-label-sm mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-hairline pt-4 text-ink-faint">
              <span>node {doctor.node}</span>
              <span>agent-sdk {doctor.sdkVersion}</span>
              <span>port {doctor.port}</span>
              <span>{doctor.runningTerminals} terminal(s) running</span>
              <span className="col-span-2 truncate" title={doctor.skillsLinkDir}>
                skills link → {doctor.skillsLinkDir}
              </span>
            </div>
          </>
        )}
      </Card>

      {settings && (
        <Card className="space-y-4">
          <h2 className="m3-title-sm">Behaviour</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Open files with</Label>
              <Input
                value={settings["ide.command"]}
                onChange={(e) => update.mutate({ "ide.command": e.target.value })}
                placeholder="xed | idea | code"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label>Tool approval timeout (s)</Label>
              <Input
                type="number"
                value={settings["permission.timeoutSec"]}
                onChange={(e) =>
                  update.mutate({ "permission.timeoutSec": Number(e.target.value) || 120 })
                }
              />
            </div>
            <div>
              <Label>Max parallel Claude turns</Label>
              <Input
                type="number"
                value={settings["concurrency.maxTurns"]}
                onChange={(e) =>
                  update.mutate({ "concurrency.maxTurns": Number(e.target.value) || 3 })
                }
              />
            </div>
            <div>
              <Label>Terminal scrollback (bytes)</Label>
              <Input
                type="number"
                value={settings["terminal.scrollbackBytes"]}
                onChange={(e) =>
                  update.mutate({ "terminal.scrollbackBytes": Number(e.target.value) || 204800 })
                }
              />
            </div>
          </div>

          <div className="space-y-2 border-t border-hairline pt-4">
            {(
              [
                ["concurrency.repoLock", "Block two sessions running in the same repo at once"],
                ["notifications.enabled", "Desktop notifications for finished turns"],
                ["git.useWorktreeDefault", "New sessions get their own git worktree by default"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(e) => update.mutate({ [key]: e.target.checked })}
                  className="accent-(--color-accent)"
                />
                {label}
              </label>
            ))}
            <BrowserNotificationOptIn />
          </div>
        </Card>
      )}

      <JiraSettings />
      <GitHubSettings />
      <BackupSettings />
      <InterfaceStateSettings />
    </div>
  );
}

/**
 * Restored UI state is guessed from what you did last, and a guess can land
 * somewhere unhelpful — a tab pinned open, a stale draft you keep dismissing.
 * Without this the only cure is clearing localStorage by hand in devtools.
 */
function InterfaceStateSettings() {
  const [done, setDone] = useState(false);

  return (
    <Card className="mt-4 space-y-3">
      <h2 className="m3-title-sm">Interface state</h2>
      <p className="text-xs text-ink-muted">
        Open tabs, selected items, scroll positions and unsaved drafts are remembered per project so
        switching away and back returns you where you were. Resetting clears all of it — projects,
        files and settings are untouched.
      </p>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            resetUiState();
            setDone(true);
          }}
        >
          <RotateCcw size={16} /> Reset interface state
        </Button>
        {done && <span className="text-xs text-ok">Cleared — reload to start fresh.</span>}
      </div>
    </Card>
  );
}

/** The OS-level fallback works regardless; this is the in-browser one. */
function BrowserNotificationOptIn() {
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    "Notification" in window ? Notification.permission : "denied",
  );
  if (!("Notification" in window) || permission === "granted") return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="mt-1"
      onClick={() => void Notification.requestPermission().then(setPermission)}
    >
      <Bell size={16} /> Allow browser notifications
    </Button>
  );
}

interface JiraStatus {
  configured: boolean;
  baseUrl?: string;
  email?: string;
  deployment?: "cloud" | "server";
}

function JiraSettings() {
  const { data: status } = useQuery({
    queryKey: ["jira-status"],
    queryFn: () => api.get<JiraStatus>("/api/jira/status"),
  });
  if (!status) return null;
  // Keyed on the loaded config, so the form initialises from it instead of
  // syncing through an effect.
  return (
    <JiraForm
      key={`${status.baseUrl ?? ""}|${status.email ?? ""}|${status.deployment ?? ""}`}
      status={status}
    />
  );
}

function JiraForm({ status }: { status: JiraStatus }) {
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(status.baseUrl ?? "");
  const [deployment, setDeployment] = useState<"cloud" | "server">(status.deployment ?? "cloud");
  const [email, setEmail] = useState(status.email ?? "");
  const [apiToken, setApiToken] = useState("");
  const isServer = deployment === "server";

  const save = useMutation({
    mutationFn: () =>
      api.put("/api/integrations/jira", {
        baseUrl,
        deployment,
        email: isServer ? "" : email,
        apiToken,
      }),
    onSuccess: () => {
      setApiToken("");
      void qc.invalidateQueries({ queryKey: ["jira-status"] });
    },
  });

  return (
    <Card className="mt-4 space-y-3">
      <h2 className="m3-title-sm">Jira</h2>
      <p className="text-xs text-ink-muted">
        {isServer
          ? "Personal Access Token from your Jira profile (Profile → Personal Access Tokens)."
          : "API token from id.atlassian.com."}{" "}
        Stored in the local DB in plain text and never sent anywhere but your Jira instance.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Deployment</Label>
          <Select
            size="md"
            className="w-full"
            value={deployment}
            onChange={(v) => setDeployment(v as "cloud" | "server")}
            options={[
              { value: "cloud", label: "Jira Cloud (*.atlassian.net)" },
              { value: "server", label: "Self-hosted (Server / Data Center)" },
            ]}
          />
        </div>
        <div>
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              isServer ? "https://jira.yourcompany.com" : "https://yourteam.atlassian.net"
            }
            className="font-mono text-xs"
          />
        </div>
        {!isServer && (
          <div>
            <Label>Email</Label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
        )}
        <div>
          <Label>
            {isServer ? "Personal Access Token" : "API token"}{" "}
            {status.configured && <span className="text-ok">(stored)</span>}
          </Label>
          <Input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder={status.configured ? "leave blank to keep" : "paste token"}
          />
        </div>
      </div>
      {save.isError && (
        <p className="text-xs text-err">
          {save.error instanceof Error ? save.error.message : "Failed"}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="primary"
          disabled={!baseUrl || (!isServer && !email) || !apiToken || save.isPending}
          onClick={() => save.mutate()}
        >
          Save Jira config
        </Button>
      </div>
    </Card>
  );
}

function GitHubSettings() {
  const { data } = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => api.get<{ repos: string[] }>("/api/github/repos"),
  });
  if (!data) return null;
  const initial = data.repos.join("\n");
  return <GitHubForm key={initial} initial={initial} />;
}

function GitHubForm({ initial }: { initial: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState(initial);

  const save = useMutation({
    mutationFn: () =>
      api.put("/api/integrations/github", {
        // Full URLs / ssh remotes are fine — store the normalized owner/name.
        repos: text
          .split("\n")
          .map((l) => normalizeGithubRepo(l) ?? l.trim())
          .filter(Boolean),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-repos"] }),
  });

  return (
    <Card className="mt-4 space-y-3">
      <h2 className="m3-title-sm">GitHub</h2>
      <p className="text-xs text-ink-muted">
        One repo per line — <code className="font-mono">owner/name</code> or a full GitHub URL. Auth
        comes from the <code className="font-mono">gh</code> CLI — no token stored here.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"AperoVN/reelme-ios\nAperoVN/reelme-api"}
        className="m3-body-sm w-full rounded-md px-3.5 py-2 font-mono placeholder:text-ink-faint border border-outline/45 bg-white/3 text-ink transition-[border-color,background-color] duration-200 ease-emphasized hover:border-outline/80 focus:border-primary focus:outline-none"
      />
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save repos
        </Button>
      </div>
    </Card>
  );
}

/** Whole-app export/import — move the station (and all its data) between machines. */
function BackupSettings() {
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const doImport = useMutation({
    mutationFn: (file: File) =>
      uploadFile<{ ok: boolean; backupDir: string; note: string }>("/api/import", file),
    onSuccess: (r) =>
      setResult({
        tone: "ok",
        text: `Imported. Previous data moved to ${r.backupDir}. ${r.note}`,
      }),
    onError: (err: unknown) =>
      setResult({ tone: "err", text: err instanceof Error ? err.message : String(err) }),
  });

  return (
    <Card className="mt-4 space-y-3">
      <h2 className="m3-title-sm">Backup & migrate</h2>
      <p className="text-xs text-ink-muted">
        Export bundles the database, knowledge, skills, agent bundles and attachments into one
        archive. Import it on another machine running this app — absolute paths inside the database
        are rewritten to the new data dir, current data is moved aside (never deleted), and skills
        are relinked. Worktrees, logs and the auth token stay machine-local; project repo paths are
        kept as-is, fix them in each project if the new machine differs.
      </p>
      <div className="flex items-center gap-2">
        <a href={fileUrl("/api/export")}>
          <Button size="sm" variant="primary">
            <Download size={16} /> Export data
          </Button>
        </a>
        <Button
          size="sm"
          variant="ghost"
          disabled={doImport.isPending}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={16} /> {doImport.isPending ? "Importing…" : "Import archive"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.tgz,application/gzip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void confirm({
              title: "Import this archive?",
              body: "Current data will be moved aside and replaced — you must restart the server afterwards.",
              confirmLabel: "Import",
              tone: "danger",
            }).then((ok) => {
              if (!ok) return;
              setResult(null);
              doImport.mutate(file);
            });
          }}
        />
      </div>
      {result && (
        <p className={result.tone === "ok" ? "text-xs text-ok" : "text-xs text-err"}>
          {result.text}
        </p>
      )}
    </Card>
  );
}
