import type { FixLogEntry, FixProgress } from "./fixer.js";
import { getAllFixProgress } from "./fixer.js";

// --- Analysis progress tracking (mirrors fixer.ts pattern) ---

export interface AnalysisJobProgress {
  steps: FixLogEntry[];
  output: string[];
  startedAt: string;
  finishedAt?: string;
  commentCount: number;
}

const analysisLogs = new Map<string, AnalysisJobProgress>();

function jobKey(repo: string, prNumber: number): string {
  return `${repo}:${prNumber}`;
}

export function startAnalysisJob(repo: string, prNumber: number, commentCount: number): void {
  const key = jobKey(repo, prNumber);
  analysisLogs.set(key, {
    steps: [],
    output: [],
    startedAt: new Date().toISOString(),
    commentCount,
  });
}

export function updateAnalysisStep(repo: string, prNumber: number, step: string, detail?: string): void {
  const key = jobKey(repo, prNumber);
  const progress = analysisLogs.get(key);
  if (!progress) return;
  for (const s of progress.steps) {
    if (s.status === "active") s.status = "done";
  }
  progress.steps.push({ step, status: "active", detail, ts: new Date().toISOString() });
}

export function addAnalysisOutput(repo: string, prNumber: number, line: string): void {
  const key = jobKey(repo, prNumber);
  const progress = analysisLogs.get(key);
  if (!progress) return;
  progress.output.push(line);
  if (progress.output.length > 200) {
    progress.output = progress.output.slice(-200);
  }
}

export function completeAnalysisJob(repo: string, prNumber: number): void {
  const key = jobKey(repo, prNumber);
  const progress = analysisLogs.get(key);
  if (!progress) return;
  for (const s of progress.steps) {
    if (s.status === "active") s.status = "done";
  }
  progress.finishedAt = new Date().toISOString();
  // Keep visible for 15 seconds after completion, then remove
  setTimeout(() => analysisLogs.delete(key), 15000);
}

export function failAnalysisJob(repo: string, prNumber: number, error: string): void {
  const key = jobKey(repo, prNumber);
  const progress = analysisLogs.get(key);
  if (!progress) return;
  for (const s of progress.steps) {
    if (s.status === "active") {
      s.status = "error";
      s.detail = error;
    }
  }
  progress.finishedAt = new Date().toISOString();
  // Keep errors visible longer
  setTimeout(() => analysisLogs.delete(key), 30000);
}

export function getAnalysisProgress(repo: string, prNumber: number): AnalysisJobProgress | null {
  return analysisLogs.get(jobKey(repo, prNumber)) ?? null;
}

// --- Unified job listing ---

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
  steps: FixLogEntry[];
  output: string[];
}

function parseJobKey(key: string): { repo: string; prNumber: number } {
  const lastColon = key.lastIndexOf(":");
  return {
    repo: key.slice(0, lastColon),
    prNumber: parseInt(key.slice(lastColon + 1), 10),
  };
}

export function getAllJobs(): Job[] {
  const jobs: Job[] = [];

  // Analysis jobs
  for (const [key, progress] of analysisLogs) {
    const { repo, prNumber } = parseJobKey(key);
    const hasError = progress.steps.some((s) => s.status === "error");
    const isFinished = !!progress.finishedAt;
    const activeStep = progress.steps.find((s) => s.status === "active");

    jobs.push({
      id: `analyze:${key}`,
      type: "analyze",
      repo,
      prNumber,
      status: hasError ? "error" : isFinished ? "done" : "running",
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      currentStep: activeStep?.step ?? progress.steps[progress.steps.length - 1]?.step,
      commentCount: progress.commentCount,
      steps: progress.steps,
      output: progress.output,
    });
  }

  // Fix jobs from fixer's fixLogs
  const allFixProgress = getAllFixProgress();
  for (const [key, progress] of allFixProgress) {
    const { repo, prNumber } = parseJobKey(key);
    const hasError = progress.steps.some((s) => s.status === "error");
    const isFinished = !!progress.finishedAt;
    const activeStep = progress.steps.find((s) => s.status === "active");

    jobs.push({
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
  jobs.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });

  return jobs;
}
