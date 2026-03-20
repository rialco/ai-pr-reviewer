import { useQuery } from "@tanstack/react-query";

export interface JobStep {
  step: string;
  status: "active" | "done" | "error";
  detail?: string;
  ts: string;
}

export interface Job {
  id: string;
  type: "analyze" | "fix";
  repo: string;
  prNumber: number;
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  commentCount?: number;
  steps: JobStep[];
  output: string[];
}

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: async () => {
      const res = await fetch("/api/prs/jobs");
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json() as Promise<Job[]>;
    },
    refetchInterval: (query) => {
      const data = query.state.data as Job[] | undefined;
      // Poll fast when there are running jobs, slower otherwise
      if (data?.some((j) => j.status === "running")) return 2000;
      if (data && data.length > 0) return 5000;
      return 15000;
    },
  });
}
