import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CircleAlert, CircleCheck } from "lucide-react";
import { normalizeGithubRepo, type AppSettings } from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";

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
        <CircleCheck size={14} className="mt-0.5 shrink-0 text-ok" />
      ) : (
        <CircleAlert size={14} className="mt-0.5 shrink-0 text-err" />
      )}
      <div className="min-w-0">
        <span className="text-sm">{label}</span>
        {detail && (
          <p className="truncate font-mono text-[11px] text-ink-faint" title={detail}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: doctor } = useQuery({ queryKey: ["doctor"], queryFn: () => api.get<Doctor>("/api/doctor") });
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
      <h1 className="mb-1 text-lg font-semibold">Settings</h1>
      <p className="mb-5 text-sm text-ink-muted">
        Behaviour lives in the local DB and applies immediately. Ports and data paths come from{" "}
        <code className="font-mono text-ink-muted">.env</code>.
      </p>

      <Card className="mb-4">
        <h2 className="mb-2 text-sm font-medium">Doctor</h2>
        {!doctor && <p className="text-sm text-ink-muted">Checking…</p>}
        {doctor && (
          <>
            <Check ok={doctor.pty.ok} label="node-pty (terminals)" detail={doctor.pty.detail} />
            <Check ok={doctor.claudeCli.ok} label="claude CLI" detail={doctor.claudeCli.detail} />
            <Check ok={doctor.gh.ok} label="gh CLI login" detail={doctor.gh.detail} />
            <Check ok={doctor.git.ok} label="git" detail={doctor.git.detail} />
            <Check
              ok={doctor.dataDirWritable}
              label="data dir writable"
              detail={doctor.dataDir}
            />
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-edge pt-3 text-[11px] text-ink-faint">
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
          <h2 className="text-sm font-medium">Behaviour</h2>

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

          <div className="space-y-2 border-t border-edge pt-3">
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
    </div>
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
      <Bell size={13} /> Allow browser notifications
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
      <h2 className="text-sm font-medium">Jira</h2>
      <p className="text-xs text-ink-muted">
        {isServer
          ? "Personal Access Token from your Jira profile (Profile → Personal Access Tokens)."
          : "API token from id.atlassian.com."}{" "}
        Stored in the local DB in plain text and never sent anywhere but your Jira instance.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Deployment</Label>
          <select
            value={deployment}
            onChange={(e) => setDeployment(e.target.value as "cloud" | "server")}
            className="h-9 w-full rounded-md border border-edge bg-surface px-2 text-sm text-ink"
          >
            <option value="cloud">Jira Cloud (*.atlassian.net)</option>
            <option value="server">Self-hosted (Server / Data Center)</option>
          </select>
        </div>
        <div>
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={isServer ? "https://jira.yourcompany.com" : "https://yourteam.atlassian.net"}
            className="font-mono text-xs"
          />
        </div>
        {!isServer && (
          <div>
            <Label>Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
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
      <h2 className="text-sm font-medium">GitHub</h2>
      <p className="text-xs text-ink-muted">
        One repo per line — <code className="font-mono">owner/name</code> or a full GitHub URL.
        Auth comes from the <code className="font-mono">gh</code> CLI — no token stored here.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"AperoVN/reelme-ios\nAperoVN/reelme-api"}
        className="w-full rounded-md border border-edge bg-surface px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
      />
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save repos
        </Button>
      </div>
    </Card>
  );
}
