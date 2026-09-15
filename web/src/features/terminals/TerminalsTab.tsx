import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Select } from "@/components/ui/select";
import {
  ExternalLink,
  History,
  Plus,
  RotateCw,
  ShieldQuestionMark,
  ToggleOff,
  ToggleOn,
  Trash2,
  X,
} from "@/components/ui/icons";
import type {
  CliSession,
  EnvSet,
  Project,
  TerminalHistoryItem,
  TerminalKind,
} from "@claude-station/shared";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { usePanelActive } from "@/components/KeepAlive";
import { useSettings, useUpdateSettings } from "@/features/settings/hooks";
import { projectKey, useUiState } from "@/lib/uiStore";
import { cn } from "@/lib/utils";
import { TerminalPane } from "./TerminalPane";
import {
  useCliSessions,
  useContinueCliSession,
  useAgentClis,
  useCreateTerminal,
  useDeleteCliSession,
  useDeleteTerminalRecord,
  useExportTerminal,
  useKillTerminal,
  useRestartTerminal,
  useTerminalHistory,
  useTerminalDiagnostics,
  useTerminals,
} from "./hooks";

interface Props {
  project: Project;
  envSets: EnvSet[];
  /** "shell" = the Terminals tab; "claude" = the Claude tab (PTYs running the claude CLI). */
  kind?: TerminalKind;
}

export function TerminalsTab({ project, envSets, kind = "shell" }: Props) {
  const { data: terminals = [], isLoading } = useTerminals(project.id, kind);
  const create = useCreateTerminal(project.id);
  const { data: agents = [] } = useAgentClis();
  const [diagnosticsFor, setDiagnosticsFor] = useState<string | null>(null);
  const kill = useKillTerminal(project.id);
  const restart = useRestartTerminal(project.id);
  const handoff = useExportTerminal(project.id);
  const forget = useDeleteTerminalRecord(project.id);

  const onScreen = usePanelActive();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const tmuxMode = settings?.["terminal.tmux"] ?? true;
  // "Work with Claude" deep-links land here as ?terminal=<id>&seed=<text>.
  //
  // Read from the URL on every render rather than once at mount: this panel is
  // kept alive behind other pages, so a link from GitHub or Jira arrives at a
  // component that never remounts, and a mount-time read would honour only the
  // first link of the session. Only the Claude panel owns these params, and
  // never while hidden — it would be answering for the page on screen.
  const [params, setParams] = useSearchParams();
  const deepLinked = kind === "claude" && onScreen;
  const seedTarget = deepLinked ? params.get("terminal") : null;
  const seed = deepLinked ? params.get("seed") : null;

  // Keyed by kind: the Claude tab and the Terminals tab each keep their own.
  const ui = (...parts: string[]) => projectKey(project.id, "terminals", kind, ...parts);
  const [selectedId, setSelectedId] = useUiState<string | null>(ui("selectedId"), null);
  const [historyOpen, setHistoryOpen] = useUiState(ui("historyOpen"), false);
  // Only fetched while the panel is open — closed sessions don't change on their own.
  const { data: history = [] } = useTerminalHistory(project.id, kind, historyOpen && onScreen);
  // Shells have no transcripts, so the CLI list is the Claude tab's business only.
  const cliEnabled = historyOpen && onScreen && kind === "claude";
  const { data: cliSessions = [] } = useCliSessions(project.id, cliEnabled);
  const continueCli = useContinueCliSession(project.id);
  const forgetCli = useDeleteCliSession(project.id);
  const [storedPathId, setPathId] = useUiState(ui("pathId"), project.paths[0]?.id ?? "");
  const [storedEnvSetId, setEnvSetId] = useUiState(ui("envSetId"), "");
  // A repo or env set can disappear between visits; "" is a valid env choice.
  const pathId = project.paths.some((p) => p.id === storedPathId)
    ? storedPathId
    : (project.paths[0]?.id ?? "");
  const envSetId = envSets.some((e) => e.id === storedEnvSetId) ? storedEnvSetId : "";

  // A deep link outranks whatever was selected last time — but it only fires on
  // the arriving link, so a later click on another terminal still wins.
  useEffect(() => {
    if (seedTarget) setSelectedId(seedTarget);
  }, [seedTarget, setSelectedId]);

  // One-shot: the params go once the prompt is actually in the CLI, so a reload
  // or a tab switch never types it a second time — and an arrival that never
  // reaches a running terminal keeps its seed instead of dropping it silently.
  // Functional form: ?tab= may be written in the same tick, and a snapshot-based
  // write here would silently roll it back.
  const clearSeed = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("terminal");
        next.delete("seed");
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  // Tabs are the sessions something still holds: running, or detached with their
  // tmux session alive. An orphaned row with nothing behind it is finished work —
  // it belongs in History, where Continue reopens it, instead of sitting here as a
  // tab that only ever offers to start over.
  const live = terminals.filter(
    (t) => t.status === "running" || (t.status === "orphaned" && t.tmuxAlive),
  );
  // Derived, not synced: the selection falls back to the first live tab.
  const activeId =
    selectedId && live.some((t) => t.id === selectedId) ? selectedId : (live[0]?.id ?? null);
  const setActiveId = setSelectedId;

  // A running shell shouldn't die to a stray Cmd+W.
  useEffect(() => {
    const anyRunning = live.some((t) => t.status === "running");
    if (!anyRunning) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);

  const active = live.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {live.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={cn(
                "state-layer m3-label-md group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-pill px-3 font-semibold",
                "transition-[background-color,color] duration-200 ease-emphasized",
                activeId === t.id
                  ? "bg-inverse-surface text-on-inverse-surface"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  t.status === "running" ? "bg-ok" : "bg-ink-faint",
                )}
              />
              {t.title}
              <X
                size={16}
                className="-mr-1 opacity-0 transition-opacity duration-150 group-hover:opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  kill.mutate(t.id);
                }}
              />
            </button>
          ))}
          {isLoading && <span className="m3-body-sm text-ink-muted">Loading…</span>}
        </div>

        <Select
          value={pathId}
          onChange={setPathId}
          aria-label="Repo"
          options={project.paths.map((p) => ({ value: p.id, label: p.label }))}
        />
        <Select
          value={envSetId}
          onChange={setEnvSetId}
          aria-label="Env set"
          options={[
            { value: "", label: "No env set" },
            ...envSets.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => updateSettings.mutate({ "terminal.tmux": !tmuxMode })}
          disabled={updateSettings.isPending || !settings}
          title={
            tmuxMode
              ? "tmux mode: a session survives a reload and can be handed to a real terminal window. The cost is a full-screen repaint after every burst of output, which is what makes a fast scroll feel less smooth than a terminal. Click to turn off — affects terminals you open from now on."
              : "Direct mode: the PTY is wired straight to the tab, so output is as smooth as the browser can draw it. No handing a session to a real terminal, and a reload asks the program to redraw rather than restoring a held screen. Click to turn on tmux — affects terminals you open from now on."
          }
        >
          {tmuxMode ? <ToggleOn size={16} /> : <ToggleOff size={16} />} tmux
        </Button>
        <Button
          size="sm"
          variant={historyOpen ? "secondary" : "ghost"}
          onClick={() => setHistoryOpen(!historyOpen)}
          title="Sessions you closed — continue one, or delete it for good"
        >
          <History size={16} /> History
        </Button>
        {/* Only a session that really is inside tmux can be handed over — which is
            not the same as the setting: rows created while it was on keep working. */}
        {active?.status === "running" && active.tmuxAlive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => handoff.mutate(active.id)}
            disabled={handoff.isPending}
            title={`Attach this session in a real terminal window and let go of it here — same process, ${
              kind === "claude" ? "same conversation" : "same shell"
            }`}
          >
            <ExternalLink size={16} /> Open in Terminal
          </Button>
        )}
        {active && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDiagnosticsFor(active.id)}
            title="Everything needed to say why this tab did not start"
          >
            <ShieldQuestionMark size={16} />
          </Button>
        )}
        <Button
          size="sm"
          onClick={() =>
            create.mutate(
              { cwdPathId: pathId || undefined, envSetId: envSetId || null, kind },
              { onSuccess: (t) => setActiveId(t.id) },
            )
          }
          disabled={create.isPending || project.paths.length === 0}
        >
          <Plus size={16} /> {kind === "claude" ? "Claude" : "Terminal"}
        </Button>
        {/* Other agent CLIs get the terminal and nothing else — no station tools,
            no turn record. The menu says so rather than implying parity. */}
        {kind === "shell" && agents.length > 0 && (
          <Select
            value=""
            size="sm"
            placeholder="Agent…"
            aria-label="Start another agent CLI"
            onChange={(agentCli) =>
              create.mutate(
                { cwdPathId: pathId || undefined, envSetId: envSetId || null, agentCli },
                { onSuccess: (t) => setActiveId(t.id) },
              )
            }
            options={agents.map((a) => ({
              value: a.id,
              label: a.installed ? a.label : `${a.label} — not installed`,
              disabled: !a.installed,
            }))}
          />
        )}
      </div>

      {diagnosticsFor && (
        <DiagnosticsDialog id={diagnosticsFor} onClose={() => setDiagnosticsFor(null)} />
      )}

      {historyOpen && (
        <HistoryPanel
          kind={kind}
          items={history}
          pending={restart.isPending || forget.isPending}
          onContinue={(id) =>
            restart.mutate(id, {
              onSuccess: () => {
                setActiveId(id);
                setHistoryOpen(false);
              },
            })
          }
          onForget={(id) => forget.mutate(id)}
          cliSessions={kind === "claude" ? cliSessions : undefined}
          cliPending={continueCli.isPending || forgetCli.isPending}
          onContinueCli={(sessionId) =>
            continueCli.mutate(sessionId, {
              onSuccess: (row) => {
                setActiveId(row.id);
                setHistoryOpen(false);
              },
            })
          }
          onForgetCli={(sessionId) => forgetCli.mutate(sessionId)}
        />
      )}

      <div className={cn("min-h-0 flex-1", historyOpen && "hidden")}>
        {!active && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            {kind === "claude" ? (
              <>
                <p className="m3-title-md">No Claude session open.</p>
                <p className="m3-body-sm text-ink-faint">
                  Pick a repo and hit <span className="text-ink-muted">+ Claude</span> — the{" "}
                  <code className="font-mono text-ink-muted">claude</code> CLI runs right here.
                  Sessions you closed are under <span className="text-ink-muted">History</span>, and
                  can be picked back up.
                </p>
              </>
            ) : (
              <>
                <p className="m3-title-md">No terminal open.</p>
                <p className="m3-body-sm text-ink-faint">
                  Open one and run <code className="font-mono text-ink-muted">claude</code> inside
                  it. Shells you closed are under <span className="text-ink-muted">History</span>.
                </p>
              </>
            )}
          </div>
        )}
        {active?.status === "orphaned" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Badge tone={active.tmuxAlive ? "accent" : "err"}>
              {active.tmuxAlive ? "detached" : "orphaned"}
            </Badge>
            <p className="m3-body-sm max-w-sm text-ink-muted">
              {active.tmuxAlive
                ? "Nothing is attached here, but the process is still alive in its tmux session — handed to a terminal window, or left over from a server restart. Reattaching picks it up exactly where it is."
                : kind === "claude"
                  ? "This Claude session belonged to a previous server process. Restart resumes the last conversation in this directory via claude --continue."
                  : "This shell belonged to a previous server process, so its output is gone. Restart it to get a fresh shell in the same directory."}
            </p>
            <Button
              size="sm"
              onClick={() => restart.mutate(active.id)}
              disabled={restart.isPending}
            >
              <RotateCw size={16} />{" "}
              {active.tmuxAlive
                ? "Reattach"
                : kind === "claude"
                  ? "Restart Claude"
                  : "Restart shell"}
            </Button>
          </div>
        )}
        {active?.status === "running" && (
          <TerminalPane
            key={active.id}
            terminalId={active.id}
            cwd={active.cwd}
            seedText={seed && active.id === seedTarget ? seed : undefined}
            onSeedSent={clearSeed}
          />
        )}
      </div>

      {active && !historyOpen && (
        <div className="m3-label-sm border-t border-hairline px-4 py-2.5 font-mono text-ink-faint">
          {active.cwd}
          {active.envSetId && <span className="ml-2 text-accent">env applied</span>}
          {handoff.error && (
            <span className="ml-2 text-err">
              {handoff.error instanceof Error ? handoff.error.message : "Hand-off failed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Closed sessions, in two parts.
 *
 * The app's own rows come first: a Claude row continues by session id, so the
 * conversation that comes back is this row's own — `claude --continue` would have
 * grabbed whichever one in the directory was newest.
 *
 * Then the conversations the CLI itself remembers for these directories, which is
 * everything you ever ran from a real terminal too. Continuing one hands it to a new
 * tab that adopts its session id, after which it is an ordinary row of the app — so a
 * conversation you opened here shows up in both parts, deliberately: each part says
 * plainly where its data comes from.
 *
 * Deleting asks nothing, in either part, and cannot be undone.
 */
function HistoryPanel({
  kind,
  items,
  pending,
  onContinue,
  onForget,
  cliSessions,
  cliPending,
  onContinueCli,
  onForgetCli,
}: {
  kind: TerminalKind;
  items: TerminalHistoryItem[];
  pending: boolean;
  onContinue: (id: string) => void;
  onForget: (id: string) => void;
  /** Undefined on the Terminals tab: a shell leaves no transcript behind. */
  cliSessions?: CliSession[];
  cliPending: boolean;
  onContinueCli: (sessionId: string) => void;
  onForgetCli: (sessionId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {cliSessions && <h3 className="m3-label-md mb-2 text-ink-muted">Sessions in this app</h3>}
      {items.length === 0 && (
        <p className="m3-body-sm text-ink-faint">
          Nothing closed yet. {kind === "claude" ? "A Claude session" : "A shell"} you close shows
          up here, and can be picked back up.
        </p>
      )}
      <div className="space-y-1.5">
        {items.map((t) => (
          <Card key={t.id} className="group flex items-center gap-2 p-2.5">
            <button
              onClick={() => onContinue(t.id)}
              disabled={pending}
              className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
              title={
                kind === "claude"
                  ? t.transcript
                    ? "Continue this conversation"
                    : "Transcript is gone — this reopens Claude in the same directory"
                  : "Open a shell in the same directory"
              }
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{t.title}</span>
                {t.status === "orphaned" && <Badge>left from a restart</Badge>}
                {kind === "claude" && !t.transcript && <Badge tone="err">no transcript</Badge>}
              </div>
              <p className="truncate font-mono m3-label-sm text-ink-faint">
                {t.cwd}
                <span className="ml-2">
                  {t.closedAt
                    ? `closed ${new Date(t.closedAt).toLocaleString()}`
                    : `opened ${new Date(t.createdAt).toLocaleString()}`}
                </span>
              </p>
            </button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onContinue(t.id)}
              disabled={pending}
              aria-label="Continue session"
            >
              <RotateCw size={16} /> Continue
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="opacity-0 group-hover:opacity-100"
              onClick={() => onForget(t.id)}
              disabled={pending}
              aria-label="Delete from history"
              title={
                kind === "claude"
                  ? "Delete this session and its transcript — no undo"
                  : "Delete this session from history — no undo"
              }
            >
              <Trash2 size={16} />
            </Button>
          </Card>
        ))}
      </div>

      {cliSessions && (
        <>
          <h3 className="m3-label-md mt-5 mb-2 text-ink-muted">
            From the CLI{" "}
            <span className="text-ink-faint">
              — every <code className="font-mono">claude</code> conversation in this project's
              directories, including the ones you ran in a real terminal
            </span>
          </h3>
          {cliSessions.length === 0 && (
            <p className="m3-body-sm text-ink-faint">
              Nothing on disk for these directories. The CLI keeps 30 days by default (
              <code className="font-mono">cleanupPeriodDays</code>).
            </p>
          )}
          <div className="space-y-1.5">
            {cliSessions.map((c) => (
              <Card key={c.sessionId} className="group flex items-center gap-2 p-2.5">
                <button
                  onClick={() => onContinueCli(c.sessionId)}
                  disabled={cliPending}
                  className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
                  title="Open a Claude tab that resumes this conversation"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{c.title}</span>
                    {c.adopted && <Badge tone="accent">in app</Badge>}
                    {c.gitBranch && <Badge>{c.gitBranch}</Badge>}
                  </div>
                  <p className="truncate font-mono m3-label-sm text-ink-faint">
                    {c.cwd}
                    <span className="ml-2">
                      {new Date(c.modifiedAt).toLocaleString()} · {humanSize(c.sizeBytes)}
                    </span>
                  </p>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onContinueCli(c.sessionId)}
                  disabled={cliPending}
                  aria-label="Continue this conversation"
                >
                  <RotateCw size={16} /> Continue
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => onForgetCli(c.sessionId)}
                  disabled={cliPending}
                  aria-label="Delete transcript"
                  title="Delete this transcript from ~/.claude/projects — no undo, and it takes the conversation with it even if it is running elsewhere"
                >
                  <Trash2 size={16} />
                </Button>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Why this terminal is not doing anything.
 *
 * One copyable blob rather than a diagnosis: the report that used to arrive was
 * "the tab is just sitting there", and every actual cause — a binary not on the
 * server's PATH, an env set with the wrong key, a CLI that printed a complaint
 * and exited — is plain in here and invisible from outside.
 */
function DiagnosticsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useTerminalDiagnostics(id);
  const [copied, setCopied] = useState(false);

  return (
    <Dialog open onClose={onClose} title="Terminal diagnostics" className="max-w-3xl">
      {isLoading ? (
        <p className="text-sm text-ink-muted">Collecting…</p>
      ) : (
        <>
          <pre className="max-h-96 overflow-auto rounded-lg bg-black/25 p-3 font-mono text-xs whitespace-pre-wrap">
            {data?.text}
          </pre>
          <div className="mt-3 flex items-center gap-2">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(data?.text ?? "");
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
