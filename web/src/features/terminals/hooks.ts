import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Terminal, TerminalInput } from "@claude-station/shared";
import { api } from "@/lib/api";

export function useTerminals(projectId: string) {
  return useQuery({
    queryKey: ["terminals", projectId],
    queryFn: () => api.get<Terminal[]>(`/api/projects/${projectId}/terminals`),
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

export function useRestartTerminal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Terminal>(`/api/terminals/${id}/restart`),
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
