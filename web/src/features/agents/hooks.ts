import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, AgentInput } from "@claude-station/shared";
import { api } from "@/lib/api";

export function useAgents(projectId?: string) {
  return useQuery({
    queryKey: ["agents", projectId ?? "all"],
    queryFn: () =>
      api.get<Agent[]>(projectId ? `/api/agents?projectId=${projectId}` : "/api/agents"),
  });
}

/** Both listings share the cache, so a change in one refreshes the other. */
function invalidate(qc: ReturnType<typeof useQueryClient>) {
  return () => qc.invalidateQueries({ queryKey: ["agents"] });
}

export function useSaveAgent(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AgentInput) =>
      id ? api.patch<Agent>(`/api/agents/${id}`, input) : api.post<Agent>("/api/agents", input),
    onSuccess: invalidate(qc),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/agents/${id}`),
    onSuccess: invalidate(qc),
  });
}

export function useToggleProjectAgent(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, enabled }: { agentId: string; enabled: boolean }) =>
      api.put<Agent[]>(`/api/projects/${projectId}/agents`, { agentId, enabled }),
    onSuccess: invalidate(qc),
  });
}
