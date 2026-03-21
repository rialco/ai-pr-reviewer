import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useSyncExternalStore } from "react";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as T;
}

// Types matching server
export interface RepoConfig {
  owner: string;
  repo: string;
  label: string;
  botUsers: string[];
  localPath?: string;
}

export interface PRInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  author: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnrichedComment {
  id: number;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  repo: string;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  body: string;
  user: string;
  createdAt: string;
  url: string | null;
  type: "inline" | "review" | "issue_comment";
  status: string;
  analysis: {
    commentId: number;
    category: string;
    reasoning: string;
  } | null;
  fixResult: {
    commentId: number;
    filesChanged: string[];
    commitHash: string;
    commitMessage: string;
    fixedAt: string;
  } | null;
  repliedAt: string | null;
  replyBody: string | null;
}

export interface FixLogEntry {
  step: string;
  status: "active" | "done" | "error";
  detail?: string;
  ts: string;
}

export interface FixProgress {
  steps: FixLogEntry[];
  output: string[];
  startedAt: string;
  finishedAt?: string;
}

export interface PRStatus {
  phase: string;
  reviewCycle: number;
  reviewScores: Record<string, number | null>;
  lastFixedAt: string | null;
  lastReReviewAt: string | null;
  fixResults: Array<{
    commentId: number;
    filesChanged: string[];
    commitHash: string;
    commitMessage: string;
    fixedAt: string;
  }>;
  fixableCount: number;
  fixProgress: FixProgress | null;
  fixHistory: FixProgress[];
}

export interface AppSettings {
  autoReReview: boolean;
}

export interface DashboardSummary {
  repos: number;
  totalComments: number;
  lastPollAt: string | null;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
}

// Repos
export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RepoConfig[]>("/api/repos"),
  });
}

export function useAddRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { owner: string; repo: string; localPath?: string }) =>
      fetchJson<RepoConfig>("/api/repos", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["repos"] });
      qc.invalidateQueries({ queryKey: ["prs"] });
    },
  });
}

export function useRemoveRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label, hard }: { label: string; hard?: boolean }) =>
      fetchJson("/api/repos/" + encodeURIComponent(label) + (hard ? "?hard=true" : ""), {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
}

// PRs
export function useOpenPRs() {
  return useQuery({
    queryKey: ["prs"],
    queryFn: () => fetchJson<PRInfo[]>("/api/prs"),
    refetchInterval: 5 * 60 * 1000, // Auto-refresh every 5 min
  });
}

// Sync a specific repo (list PRs, fetch comments, clean up stale)
export function useSyncRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoLabel: string) =>
      fetchJson<{ prs: number; newComments: number; cleaned: number }>(
        `/api/prs/sync/${encodeURIComponent(repoLabel)}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["prs"] });
      qc.invalidateQueries({ queryKey: ["reviews"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Comments for a PR
export function usePRComments(repo: string, prNumber: number) {
  return useQuery({
    queryKey: ["comments", repo, prNumber],
    queryFn: () =>
      fetchJson<EnrichedComment[]>(
        `/api/prs/${encodeURIComponent(repo)}/${prNumber}/comments`,
      ),
    enabled: !!repo && !!prNumber,
    refetchInterval: (query) => {
      const data = query.state.data as EnrichedComment[] | undefined;
      if (data?.some((c) => c.status === "fixing")) return 5000;
      return false;
    },
  });
}

// Refresh a specific PR's comments from GitHub.
// Also invalidates reviews since the refresh extracts Greptile scores from comments.
export function useRefreshPR() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { repo: string; prNumber: number }) =>
      fetchJson<{ newComments: number }>(
        `/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/refresh`,
        { method: "POST" },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ["comments", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({
        queryKey: ["reviews", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Analysis progress event from NDJSON stream
export interface AnalysisProgressEvent {
  type: "progress" | "complete" | "error";
  step: string;
  message: string;
  progress: number;
  detail?: string;
  analyzed?: number;
}

export interface AnalysisProgressState {
  steps: Array<{
    step: string;
    message: string;
    detail?: string;
    status: "done" | "active";
  }>;
  output: string[];
  progress: number;
  error?: string;
}

// Streaming analyze hook with progress tracking, scoped per PR
export function useAnalyze() {
  const qc = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [progressState, setProgressState] = useState<AnalysisProgressState | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const mutate = useCallback(
    async (data: { repo: string; prNumber: number; commentIds?: number[] }) => {
      const key = `${data.repo}:${data.prNumber}`;
      setIsPending(true);
      setActiveKey(key);
      setProgressState({ steps: [], output: [], progress: 0 });

      try {
        const res = await fetch(
          `/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/analyze`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commentIds: data.commentIds }),
          },
        );

        if (!res.ok) {
          throw new Error(`${res.status}: ${await res.text()}`);
        }

        const contentType = res.headers.get("content-type") ?? "";

        // Handle non-streaming response (e.g. 0 comments to analyze)
        if (!contentType.includes("ndjson")) {
          setIsPending(false);
          setProgressState(null);
          setActiveKey(null);
          qc.invalidateQueries({ queryKey: ["comments", data.repo, data.prNumber] });
          qc.invalidateQueries({ queryKey: ["summary"] });
          return;
        }

        // Read NDJSON stream
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!; // last element is incomplete or empty

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as AnalysisProgressEvent;

              if (event.type === "error") {
                setProgressState((prev) => ({
                  steps: prev?.steps ?? [],
                  output: prev?.output ?? [],
                  progress: 100,
                  error: event.message,
                }));
              } else if (event.type === "complete") {
                setProgressState((prev) => ({
                  steps: (prev?.steps ?? []).map((s) => ({ ...s, status: "done" as const })),
                  output: prev?.output ?? [],
                  progress: 100,
                }));
              } else if (event.step === "claude_output") {
                // Live output from Claude CLI
                setProgressState((prev) => ({
                  steps: prev?.steps ?? [],
                  output: [...(prev?.output ?? []), event.message],
                  progress: prev?.progress ?? 50,
                }));
              } else {
                // Progress event — mark previous steps as done, add new active step
                setProgressState((prev) => {
                  const prevSteps = (prev?.steps ?? []).map((s) => ({
                    ...s,
                    status: "done" as const,
                  }));
                  return {
                    steps: [
                      ...prevSteps,
                      {
                        step: event.step,
                        message: event.message,
                        detail: event.detail,
                        status: "active" as const,
                      },
                    ],
                    output: prev?.output ?? [],
                    progress: event.progress,
                  };
                });
              }
            } catch {
              // Skip malformed lines
            }
          }
        }

        // Invalidate queries to refresh data
        qc.invalidateQueries({ queryKey: ["comments", data.repo, data.prNumber] });
        qc.invalidateQueries({ queryKey: ["summary"] });
      } catch (err) {
        setProgressState((prev) => ({
          steps: prev?.steps ?? [],
          output: prev?.output ?? [],
          progress: 100,
          error: String(err),
        }));
      } finally {
        setIsPending(false);
        // Clear progress after a short delay so the user sees the final state
        setTimeout(() => {
          setProgressState(null);
          setActiveKey(null);
        }, 3000);
      }
    },
    [qc],
  );

  const progressFor = useCallback(
    (repo: string, prNumber: number): AnalysisProgressState | null => {
      if (activeKey !== `${repo}:${prNumber}`) return null;
      return progressState;
    },
    [activeKey, progressState],
  );

  return { mutate, isPending, progress: progressState, progressFor };
}

// Dismiss comment
export function useDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      repo: string;
      prNumber: number;
      commentId: number;
    }) =>
      fetchJson(
        `/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/dismiss/${data.commentId}`,
        { method: "POST" },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ["comments", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Reopen a dismissed comment
export function useReopen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      repo: string;
      prNumber: number;
      commentId: number;
    }) =>
      fetchJson(
        `/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/reopen/${data.commentId}`,
        { method: "POST" },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ["comments", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Override a comment's analysis category
export function useRecategorize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      repo: string;
      prNumber: number;
      commentId: number;
      category: string;
    }) =>
      fetchJson(
        `/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/recategorize/${data.commentId}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: data.category }) },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ["comments", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Fix comments
export function useFixComments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      repo: string;
      prNumber: number;
      commentIds?: number[];
    }) =>
      fetchJson(`/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/fix`, {
        method: "POST",
        body: JSON.stringify({ commentIds: data.commentIds }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ["comments", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({
        queryKey: ["prStatus", variables.repo, variables.prNumber],
      });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Revert a fix commit
export function useRevertFix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { repo: string; prNumber: number; commitHash: string }) =>
      fetchJson(`/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/revert`, {
        method: "POST",
        body: JSON.stringify({ commitHash: data.commitHash }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["comments", variables.repo, variables.prNumber] });
      qc.invalidateQueries({ queryKey: ["prStatus", variables.repo, variables.prNumber] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

// Re-review requests are now handled via useRequestReview() in the reviews system.

// Reply to fixed comments on GitHub
export function useReplyToComments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      repo: string;
      prNumber: number;
      replies: Array<{ commentId: number; body: string }>;
    }) =>
      fetchJson<{ results: Array<{ commentId: number; ok: boolean; error?: string }> }>(
        `/api/prs/${encodeURIComponent(data.repo)}/${data.prNumber}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ replies: data.replies }),
        },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["comments", variables.repo, variables.prNumber] });
    },
  });
}

// PR lifecycle status
export function usePRStatus(repo: string, prNumber: number) {
  return useQuery({
    queryKey: ["prStatus", repo, prNumber],
    queryFn: () =>
      fetchJson<PRStatus>(
        `/api/prs/${encodeURIComponent(repo)}/${prNumber}/status`,
      ),
    enabled: !!repo && !!prNumber,
    refetchInterval: (query) => {
      const data = query.state.data as PRStatus | undefined;
      if (data?.phase === "fixing") return 3000; // Poll fast while fixing
      return 10000;
    },
  });
}

// Git remote info from a local path
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

// Browse directories
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

// Update repo (localPath)
export function useUpdateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { label: string; localPath: string | null }) =>
      fetchJson<RepoConfig>(`/api/repos/${encodeURIComponent(data.label)}`, {
        method: "PATCH",
        body: JSON.stringify({ localPath: data.localPath }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
}

// Settings
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

// Summary
export function useSummary() {
  return useQuery({
    queryKey: ["summary"],
    queryFn: () => fetchJson<DashboardSummary>("/api/prs/summary"),
  });
}

// ------- Reviews -------

export interface ReviewerInfo {
  id: string;
  displayName: string;
  type: "bot" | "local-ai";
  available: boolean;
}

export interface Review {
  id?: number;
  repo: string;
  prNumber: number;
  reviewerId: string;
  confidenceScore: number | null;
  summary: string | null;
  source: "remote" | "local";
  githubReviewId: string | null;
  rawOutput: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewProgressEvent {
  type: "progress" | "complete" | "error";
  step: string;
  message: string;
  progress: number;
  detail?: string;
  review?: Review;
}

export interface ReviewProgressState {
  steps: Array<{
    step: string;
    message: string;
    detail?: string;
    status: "done" | "active";
  }>;
  output: string[];
  progress: number;
  error?: string;
}

export function useAvailableReviewers() {
  return useQuery({
    queryKey: ["reviewers"],
    queryFn: () => fetchJson<ReviewerInfo[]>("/api/reviews/reviewers"),
  });
}

export function useReviews(repo: string, prNumber: number) {
  return useQuery({
    queryKey: ["reviews", repo, prNumber],
    queryFn: () =>
      fetchJson<Review[]>(
        `/api/reviews/${encodeURIComponent(repo)}/${prNumber}`,
      ),
    enabled: !!repo && !!prNumber,
    refetchInterval: 30000, // Refresh every 30s to catch Greptile updates
  });
}

// ---- Global review request store (survives component unmounts/PR switches) ----

interface ReviewRequestEntry {
  repo: string;
  prNumber: number;
  reviewerId: string;
  isPending: boolean;
  progressState: ReviewProgressState | null;
}

/** Module-level store — lives outside the React tree */
const _reviewRequests = new Map<string, ReviewRequestEntry>();
const _listeners = new Set<() => void>();

function _notify() {
  for (const fn of _listeners) fn();
}

function _entryKey(repo: string, prNumber: number, reviewerId: string) {
  return `${repo}:${prNumber}:${reviewerId}`;
}

function _getSnapshot(): Map<string, ReviewRequestEntry> {
  return _reviewRequests;
}

function _subscribe(cb: () => void) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

async function _startReviewRequest(
  data: { repo: string; prNumber: number; reviewerId: string },
  invalidate: (repo: string, prNumber: number) => void,
) {
  const key = _entryKey(data.repo, data.prNumber, data.reviewerId);
  const entry: ReviewRequestEntry = {
    ...data,
    isPending: true,
    progressState: {
      steps: [{ step: "starting", message: "Starting review...", status: "active" as const }],
      output: [],
      progress: 5,
    },
  };
  _reviewRequests.set(key, entry);
  _notify();

  const updateProgress = (updater: (prev: ReviewProgressState) => ReviewProgressState) => {
    const current = _reviewRequests.get(key);
    if (!current) return;
    current.progressState = updater(current.progressState ?? { steps: [], output: [], progress: 0 });
    _notify();
  };

  try {
    const res = await fetch(
      `/api/reviews/${encodeURIComponent(data.repo)}/${data.prNumber}/request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewerId: data.reviewerId }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("ndjson")) {
      updateProgress((prev) => ({
        steps: prev.steps.map((s) => ({ ...s, status: "done" as const })),
        output: prev.output,
        progress: 100,
      }));
      invalidate(data.repo, data.prNumber);
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ReviewProgressEvent;
          if (event.type === "error") {
            updateProgress((prev) => ({
              ...prev,
              progress: 100,
              error: event.message,
            }));
          } else if (event.type === "complete") {
            updateProgress((prev) => ({
              steps: prev.steps.map((s) => ({ ...s, status: "done" as const })),
              output: prev.output,
              progress: 100,
            }));
          } else if (event.step === "claude_output" || event.step === "codex_output") {
            updateProgress((prev) => ({
              ...prev,
              output: [...prev.output, event.message],
            }));
          } else {
            updateProgress((prev) => ({
              steps: [
                ...prev.steps.map((s) => ({ ...s, status: "done" as const })),
                { step: event.step, message: event.message, detail: event.detail, status: "active" as const },
              ],
              output: prev.output,
              progress: event.progress,
            }));
          }
        } catch {
          // skip
        }
      }
    }

    invalidate(data.repo, data.prNumber);
  } catch (err) {
    updateProgress((prev) => ({
      ...prev,
      progress: 100,
      error: String(err),
    }));
  } finally {
    const current = _reviewRequests.get(key);
    if (current) {
      current.isPending = false;
      _notify();
    }
    // Keep entry visible briefly, then clean up
    setTimeout(() => {
      _reviewRequests.delete(key);
      _notify();
    }, 3000);
  }
}

/**
 * Hook to request AI reviews. State is stored globally (module-level)
 * so it survives component unmounts and PR switches.
 */
export function useRequestReview() {
  const qc = useQueryClient();
  const store = useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);

  const mutate = useCallback(
    (data: { repo: string; prNumber: number; reviewerId: string }) => {
      _startReviewRequest(data, (repo, prNumber) => {
        qc.invalidateQueries({ queryKey: ["reviews", repo, prNumber] });
        qc.invalidateQueries({ queryKey: ["prStatus", repo, prNumber] });
      });
    },
    [qc],
  );

  const getEntry = useCallback(
    (repo: string, prNumber: number, reviewerId: string): ReviewRequestEntry | null => {
      return store.get(_entryKey(repo, prNumber, reviewerId)) ?? null;
    },
    [store],
  );

  const isPendingFor = useCallback(
    (repo: string, prNumber: number, reviewerId: string): boolean => {
      return store.get(_entryKey(repo, prNumber, reviewerId))?.isPending ?? false;
    },
    [store],
  );

  const progressFor = useCallback(
    (repo: string, prNumber: number, reviewerId: string): ReviewProgressState | null => {
      return store.get(_entryKey(repo, prNumber, reviewerId))?.progressState ?? null;
    },
    [store],
  );

  return { mutate, getEntry, isPendingFor, progressFor };
}

// Refresh a specific reviewer's score from source
export function useRefreshReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { repo: string; prNumber: number; reviewerId: string }) =>
      fetchJson<Review | null>(
        `/api/reviews/${encodeURIComponent(data.repo)}/${data.prNumber}/fetch/${data.reviewerId}`,
        { method: "POST" },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: ["reviews", variables.repo, variables.prNumber],
      });
    },
  });
}
