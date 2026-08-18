import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CliSession,
  Terminal,
  TerminalHistoryItem,
  TerminalInput,
  TerminalKind,
} from "@claude-station/shared";
import { api } from "@/lib/api";

export function useTerminals(projectId: string, kind: TerminalKind = "shell") {
  return useQuery({
    queryKey: ["terminals", projectId, kind],
    queryFn: () => api.get<Terminal[]>(`/api/projects/${projectId}/terminals?kind=${kind}`),
  });
}

/** Sessions that have been closed — what the History panel lists. */
export function useTerminalHistory(projectId: string, kind: TerminalKind, enabled: boolean) {
  return useQuery({
    queryKey: ["terminal-history", projectId, kind],
    queryFn: () =>
      api.get<TerminalHistoryItem[]>(`/api/projects/${projectId}/terminal-history?kind=${kind}`),
    enabled,
  });
}

/**
 * Forgets a closed session: the row and, for a Claude tab, the CLI transcript with
 * it. There is no confirmation and no undo — deliberately, by request.
 */
export function useDeleteTerminalRecord(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/terminals/${id}/record`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["terminal-history", projectId] });
      qc.invalidateQueries({ queryKey: ["terminals", projectId] });
    },
  });
}

/**
 * Conversations the `claude` CLI kept for this project's directories, including the
 * ones run from a real terminal that this app has no row for.
 */
export function useCliSessions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["cli-sessions", projectId],
    queryFn: () => api.get<CliSession[]>(`/api/projects/${projectId}/cli-sessions`),
    enabled,
  });
}

/** Takes a CLI conversation over: a new Claude tab resumes it and owns it from then on. */
export function useContinueCliSession(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<Terminal>(`/api/projects/${projectId}/cli-sessions/${sessionId}/continue`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["terminals", projectId] });
      qc.invalidateQueries({ queryKey: ["cli-sessions", projectId] });
      qc.invalidateQueries({ queryKey: ["terminal-history", projectId] });
    },
  });
}

/** Deletes the transcript from disk. No guard, no undo — see the route. */
export function useDeleteCliSession(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.delete(`/api/projects/${projectId}/cli-sessions/${sessionId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cli-sessions", projectId] });
      qc.invalidateQueries({ queryKey: ["terminal-history", projectId] });
    },
  });
}

export function useCreateTerminal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TerminalInput) =>
      api.post<Terminal>(`/api/projects/${projectId}/terminals`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals", projectId] }),
  });
}

export function useKillTerminal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/terminals/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals", projectId] }),
  });
}

/** Also the "continue this one" action: a closed row comes back as a live tab. */
export function useRestartTerminal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Terminal>(`/api/terminals/${id}/restart`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["terminals", projectId] });
      qc.invalidateQueries({ queryKey: ["terminal-history", projectId] });
    },
  });
}

/**
 * Hands the session to a real terminal window. The row comes back as orphaned with
 * its tmux session alive, so Reattach in the tab brings it home again.
 */
export function useExportTerminal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ opened: string; session: string; app: string }>(
        `/api/terminals/${id}/export`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals", projectId] }),
  });
}

export function useRenameTerminal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Terminal>(`/api/terminals/${id}`, { title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals", projectId] }),
  });
}
