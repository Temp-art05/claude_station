import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectBoardInput, ProjectInput } from "@claude-station/shared";
import { api } from "@/lib/api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<Project[]>("/api/projects"),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["projects", id],
    queryFn: () => api.get<Project>(`/api/projects/${id}`),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectInput) => api.post<Project>("/api/projects", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<ProjectInput>) => api.patch<Project>(`/api/projects/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/** Re-orders a cached list to match a board, so a drop lands without a round trip. */
function applyBoard(projects: Project[], board: ProjectBoardInput): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const out: Project[] = [];
  for (const [status, ids] of [
    ["active", board.active],
    ["backlog", board.backlog],
  ] as const) {
    ids.forEach((id, i) => {
      const project = byId.get(id);
      if (project) out.push({ ...project, status, sortOrder: i });
    });
  }
  return out;
}

/**
 * Writes the board back after a drag. The cache is re-ordered up front so the
 * card stays where it was dropped instead of snapping back for a round trip;
 * a failed write restores the list as it was.
 */
export function useSaveProjectBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (board: ProjectBoardInput) => api.patch<Project[]>("/api/projects/board", board),
    onMutate: async (board) => {
      await qc.cancelQueries({ queryKey: ["projects"] });
      const previous = qc.getQueryData<Project[]>(["projects"]);
      if (previous) qc.setQueryData(["projects"], applyBoard(previous, board));
      return { previous };
    },
    onError: (_err, _board, ctx) => {
      if (ctx?.previous) qc.setQueryData(["projects"], ctx.previous);
    },
    onSuccess: (projects) => qc.setQueryData(["projects"], projects),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/projects/${id}`),
    onSuccess: (_result, id) => {
      // Drop the detail cache outright — refetching a deleted project only 404s.
      qc.removeQueries({ queryKey: ["projects", id] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
