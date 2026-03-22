import { useQuery } from "@tanstack/react-query";

export interface JobStep {
  step: string;
  status: "active" | "done" | "error";
  detail?: string;
  ts: string;
}

export type JobType = "analyze" | "fix" | "review" | "poll" | "sync" | "refresh" | "score_extract" | "coordinator";

export interface Job {
  id: string;
  type: JobType;
  repo: string;
  prNumber?: number;
  reviewerId?: string;
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  detail?: string;
  commentCount?: number;
  steps: JobStep[];
  output: string[];
}

export interface ScheduledEvent {
  id: string;
  type: string;
  description: string;
  nextRunAt: string;
  intervalMs: number;
  lastRunAt: string | null;
}

export interface ActivityFeed {
  jobs: Job[];
  scheduled: ScheduledEvent[];
}

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: async () => {
      const res = await fetch("/api/prs/jobs");
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json() as Promise<ActivityFeed>;
    },
    refetchInterval: (query) => {
      const data = query.state.data as ActivityFeed | undefined;
      if (data?.jobs.some((j) => j.status === "running")) return 2000;
      if (data && data.jobs.length > 0) return 5000;
      return 10000; // Still poll regularly so countdowns update
    },
  });
}
