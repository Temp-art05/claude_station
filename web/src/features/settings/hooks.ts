import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "@claude-station/shared";
import { api } from "@/lib/api";

export const settingsKey = ["settings"] as const;

/** Shared so a panel can read one setting without owning a copy of the query. */
export function useSettings() {
  return useQuery({ queryKey: settingsKey, queryFn: () => api.get<AppSettings>("/api/settings") });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.patch<AppSettings>("/api/settings", patch),
    onSuccess: (data) => qc.setQueryData(settingsKey, data),
  });
}
