import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as T;
}

export type ReviewerId = "greptile" | "claude" | "codex";

export interface AppSettings {
  autoReReview: boolean;
  coordinatorEnabled: boolean;
  coordinatorAgent: "claude" | "codex";
  defaultAnalyzerAgent: "claude" | "codex";
  defaultFixerAgent: "claude" | "codex";
  defaultReviewerIds: ReviewerId[];
}

export interface GitRemoteResult {
  owner: string;
  repo: string;
  remoteUrl: string;
}

export function useGitRemote(dirPath: string | null) {
  return useQuery({
    queryKey: ["gitRemote", dirPath],
    queryFn: () =>
      fetchJson<GitRemoteResult>(`/api/repos/browse/git-remote?path=${encodeURIComponent(dirPath!)}`),
    enabled: !!dirPath,
  });
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: string[];
  isGitRepo: boolean;
}

export function useBrowse(dirPath: string) {
  return useQuery({
    queryKey: ["browse", dirPath],
    queryFn: () =>
      fetchJson<BrowseResult>(`/api/repos/browse?path=${encodeURIComponent(dirPath)}`),
    enabled: !!dirPath,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<AppSettings>("/api/repos/settings"),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<AppSettings>) =>
      fetchJson<AppSettings>("/api/repos/settings", {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface ReviewerInfo {
  id: string;
  displayName: string;
  type: "bot" | "local-ai";
  available: boolean;
}

export function useAvailableReviewers() {
  return useQuery({
    queryKey: ["reviewers"],
    queryFn: () => fetchJson<ReviewerInfo[]>("/api/reviews/reviewers"),
  });
}
