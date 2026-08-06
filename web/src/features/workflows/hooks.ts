import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Workflow, WorkflowInput, WorkflowRun } from "@claude-station/shared";
import { api } from "@/lib/api";

export interface RunSummary {
  id: string;
  workflowId: string;
  title: string;
  status: WorkflowRun["status"];
  currentStepKey: string | null;
  startedAt: string;
  finishedAt: string | null;
  totalSteps: number;
  completedSteps: number;
}

export function useWorkflows(projectId?: string) {
  return useQuery({
    queryKey: ["workflows", projectId ?? "library"],
    queryFn: () =>
      api.get<Workflow[]>(projectId ? `/api/projects/${projectId}/workflows` : "/api/workflows"),
  });
}

export function useWorkflowFolders() {
  return useQuery({
    queryKey: ["workflow-folders"],
    queryFn: () => api.get<{ folder: string; count: number }[]>("/api/workflows/folders"),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  return () => {
    void qc.invalidateQueries({ queryKey: ["workflows"] });
    void qc.invalidateQueries({ queryKey: ["workflow-folders"] });
  };
}

export function useSaveWorkflow(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkflowInput) =>
      id
        ? api.patch<Workflow>(`/api/workflows/${id}`, input)
        : api.post<Workflow>("/api/workflows", input),
    onSuccess: invalidate(qc),
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/workflows/${id}`),
    onSuccess: invalidate(qc),
  });
}

export function useMoveWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, folder }: { id: string; folder: string }) =>
      api.put(`/api/workflows/${id}/folder`, { folder }),
    onSuccess: invalidate(qc),
  });
}

export function useImportToProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workflowIds?: string[]; folder?: string }) =>
      api.post<{ imported: number }>(`/api/projects/${projectId}/workflows/import`, body),
    onSuccess: invalidate(qc),
  });
}

export function useRemoveFromProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) =>
      api.delete(`/api/projects/${projectId}/workflows/${workflowId}`),
    onSuccess: invalidate(qc),
  });
}

export function useRuns(projectId: string) {
  return useQuery({
    queryKey: ["workflow-runs", projectId],
    queryFn: () => api.get<RunSummary[]>(`/api/projects/${projectId}/workflow-runs`),
    // Runs advance server-side; poll while any is live.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === "running" || r.status === "pending") ? 3000 : false,
  });
}

export function useStartRun(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      workflowId: string;
      cwdPathId?: string;
      envSetId?: string | null;
      useWorktree?: boolean;
    }) => api.post<WorkflowRun>(`/api/projects/${projectId}/workflow-runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-runs", projectId] }),
  });
}
