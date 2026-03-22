import type { RunHistoryStep } from "../types.js";
import type { FixProgress } from "./fixer.js";
import { getAllFixProgress } from "./fixer.js";

// --- General-purpose activity tracking ---

export type JobType =
  | "analyze"
  | "fix"
  | "review"
  | "poll"
  | "sync"
  | "refresh"
  | "score_extract"
  | "coordinator";

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
  steps: RunHistoryStep[];
  output: string[];
}

// --- Scheduled events ---

export interface ScheduledEvent {
  id: string;
  type: string;
  description: string;
  nextRunAt: string;
  intervalMs: number;
  lastRunAt: string | null;
}

const scheduledEvents = new Map<string, ScheduledEvent>();

export function registerScheduledEvent(
  id: string,
  type: string,
  description: string,
  intervalMs: number,
): void {
  scheduledEvents.set(id, {
    id,
    type,
    description,
    nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
    intervalMs,
    lastRunAt: null,
  });
}

export function markScheduledEventRan(id: string): void {
  const event = scheduledEvents.get(id);
  if (!event) return;
  const now = new Date();
  event.lastRunAt = now.toISOString();
  event.nextRunAt = new Date(now.getTime() + event.intervalMs).toISOString();
}

export function removeScheduledEvent(id: string): void {
  scheduledEvents.delete(id);
}

export function getScheduledEvents(): ScheduledEvent[] {
  return [...scheduledEvents.values()].sort(
    (a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime(),
  );
}

// --- Jobs ---

const jobs = new Map<string, Job>();

function makeId(type: JobType, repo: string, extra?: string): string {
  const suffix = extra ? `:${extra}` : "";
  return `${type}:${repo}${suffix}:${Date.now()}`;
}

export function startJob(
  type: JobType,
  repo: string,
  opts?: { prNumber?: number; reviewerId?: string; detail?: string; commentCount?: number },
): string {
  const id = makeId(type, repo, opts?.prNumber?.toString());
  jobs.set(id, {
    id,
    type,
    repo,
    prNumber: opts?.prNumber,
    reviewerId: opts?.reviewerId,
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: opts?.detail,
    detail: opts?.detail,
    commentCount: opts?.commentCount,
    steps: [],
    output: [],
  });
  return id;
}

export function updateJobStep(id: string, step: string, detail?: string): void {
  const job = jobs.get(id);
  if (!job) return;
  for (const s of job.steps) {
    if (s.status === "active") s.status = "done";
  }
  job.steps.push({ step, status: "active", detail, ts: new Date().toISOString() });
  job.currentStep = step;
}

export function addJobOutput(id: string, line: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.output.push(line);
  if (job.output.length > 200) {
    job.output = job.output.slice(-200);
  }
}

export function completeJob(id: string, detail?: string): void {
  const job = jobs.get(id);
  if (!job) return;
  for (const s of job.steps) {
    if (s.status === "active") s.status = "done";
  }
  job.status = "done";
  job.finishedAt = new Date().toISOString();
  if (detail) job.detail = detail;

  // Keep completed jobs visible for 60s so users can see what happened
  setTimeout(() => jobs.delete(id), 60000);
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  for (const s of job.steps) {
    if (s.status === "active") {
      s.status = "error";
      s.detail = error;
    }
  }
  job.status = "error";
  job.detail = error;
  job.finishedAt = new Date().toISOString();
  // Errors stay visible for 2 minutes
  setTimeout(() => jobs.delete(id), 120000);
}

// --- Backward-compatible analysis job functions ---

export function startAnalysisJob(
  repo: string,
  prNumber: number,
  commentCount: number,
  reviewerId?: string,
  detail?: string,
): string {
  return startJob("analyze", repo, {
    prNumber,
    reviewerId,
    commentCount,
    detail: detail ?? `Analyzing ${commentCount} comment(s)`,
  });
}

export function updateAnalysisStep(jobId: string, _repo: string, _prNumber: number, step: string, detail?: string): void {
  updateJobStep(jobId, step, detail);
}

export function addAnalysisOutput(jobId: string, _repo: string, _prNumber: number, line: string): void {
  addJobOutput(jobId, line);
}

export function completeAnalysisJob(jobId: string): void {
  completeJob(jobId);
}

export function failAnalysisJob(jobId: string, error: string): void {
  failJob(jobId, error);
}

// --- Unified listing ---

export interface ActivityFeed {
  jobs: Job[];
  scheduled: ScheduledEvent[];
}

export function getActivityFeed(): ActivityFeed {
  const allJobs: Job[] = [...jobs.values()];

  // Include fix jobs from fixer's in-memory fixLogs
  const allFixProgress = getAllFixProgress();
  for (const [key, progress] of allFixProgress) {
    const lastColon = key.lastIndexOf(":");
    const repo = key.slice(0, lastColon);
    const prNumber = parseInt(key.slice(lastColon + 1), 10);
    const hasError = progress.steps.some((s) => s.status === "error");
    const isFinished = !!progress.finishedAt;
    const activeStep = progress.steps.find((s) => s.status === "active");

    allJobs.push({
      id: `fix:${key}`,
      type: "fix",
      repo,
      prNumber,
      status: hasError ? "error" : isFinished ? "done" : "running",
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      currentStep: activeStep?.step ?? progress.steps[progress.steps.length - 1]?.step,
      steps: progress.steps,
      output: progress.output,
    });
  }

  // Sort: running first, then by start time desc
  allJobs.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });

  return {
    jobs: allJobs,
    scheduled: getScheduledEvents(),
  };
}

// Keep the old function name for backward compat with the route
export function getAllJobs(): Job[] {
  return getActivityFeed().jobs;
}
