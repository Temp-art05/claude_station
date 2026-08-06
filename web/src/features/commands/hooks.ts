import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandRun, PathCommand, PathCommandInput } from "@claude-station/shared";
import { api } from "@/lib/api";

export type CommandRunRow = CommandRun & { active: boolean };

export function useCommandRuns(projectId: string) {
  return useQuery({
    queryKey: ["command-runs", projectId],
    queryFn: () => api.get<CommandRunRow[]>(`/api/projects/${projectId}/command-runs`),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.active) ? 2000 : false,
  });
}

export function useRunCommand(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { commandId: string; extraArgs?: string; envSetId?: string | null }) =>
      api.post<{ runId: string }>(`/api/projects/${projectId}/commands/run`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["command-runs", projectId] }),
  });
}

export function useKillRun(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post(`/api/command-runs/${runId}/kill`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["command-runs", projectId] }),
  });
}

/** Remove a run from history — the server stops it first if still active. */
export function useDeleteRun(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.delete(`/api/command-runs/${runId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["command-runs", projectId] }),
  });
}

export function useCreateCommand(pathId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PathCommandInput) =>
      api.post<PathCommand>(`/api/paths/${pathId}/commands`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteCommand(pathId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commandId: string) => api.delete(`/api/paths/${pathId}/commands/${commandId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
