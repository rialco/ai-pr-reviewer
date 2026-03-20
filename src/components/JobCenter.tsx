import { useState, useRef, useEffect } from "react";
import { useJobs, type Job } from "../hooks/useJobs";
import {
  Loader2,
  Check,
  AlertCircle,
  Sparkles,
  Wrench,
  ChevronDown,
  ChevronUp,
  X,
  Activity,
} from "lucide-react";

interface JobCenterProps {
  onNavigateToPR: (repo: string, prNumber: number) => void;
}

function JobIcon({ job }: { job: Job }) {
  if (job.status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />;
  }
  if (job.status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  }
  return <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />;
}

function TypeIcon({ type }: { type: "analyze" | "fix" }) {
  if (type === "analyze") {
    return <Sparkles className="h-3 w-3 shrink-0" />;
  }
  return <Wrench className="h-3 w-3 shrink-0" />;
}

function formatDuration(startedAt: string, finishedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function shortRepo(repo: string): string {
  // "owner/repo" -> "repo"
  const parts = repo.split("/");
  return parts[parts.length - 1];
}

function JobOutputLog({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  if (lines.length === 0) return null;

  // Show only last 10 lines in the compact view
  const visibleLines = lines.slice(-10);

  return (
    <div
      ref={scrollRef}
      className="mt-2 max-h-24 overflow-y-auto rounded bg-black/60 p-2 font-mono text-[10px] text-green-400 space-y-0"
    >
      {visibleLines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all leading-tight">{line}</div>
      ))}
    </div>
  );
}

function JobCard({ job, onNavigate }: { job: Job; onNavigate: () => void }) {
  const [expanded, setExpanded] = useState(false);

  const statusColor =
    job.status === "running"
      ? "border-primary/30"
      : job.status === "error"
        ? "border-destructive/30"
        : "border-green-500/30";

  const bgColor =
    job.status === "running"
      ? "bg-primary/5"
      : job.status === "error"
        ? "bg-destructive/5"
        : "bg-green-500/5";

  return (
    <div className={`rounded-md border ${statusColor} ${bgColor} p-2.5 transition-all`}>
      {/* Header row */}
      <div className="flex items-center gap-2">
        <JobIcon job={job} />
        <button
          onClick={onNavigate}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:underline"
        >
          <TypeIcon type={job.type} />
          <span className="text-xs font-medium truncate">
            {shortRepo(job.repo)} #{job.prNumber}
          </span>
        </button>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {formatDuration(job.startedAt, job.finishedAt)}
        </span>
        {(job.steps.length > 0 || job.output.length > 0) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 rounded hover:bg-muted/50"
          >
            {expanded ? (
              <ChevronUp className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        )}
      </div>

      {/* Current step */}
      {job.currentStep && (
        <p className="text-[10px] text-muted-foreground mt-1 ml-5.5 truncate">
          {job.currentStep}
        </p>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 ml-5.5">
          {/* Steps */}
          <div className="space-y-0.5">
            {job.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px]">
                {step.status === "done" ? (
                  <Check className="h-2.5 w-2.5 text-green-500 shrink-0 mt-0.5" />
                ) : step.status === "error" ? (
                  <AlertCircle className="h-2.5 w-2.5 text-destructive shrink-0 mt-0.5" />
                ) : (
                  <Loader2 className="h-2.5 w-2.5 animate-spin text-primary shrink-0 mt-0.5" />
                )}
                <span
                  className={
                    step.status === "done"
                      ? "text-muted-foreground"
                      : step.status === "error"
                        ? "text-destructive"
                        : "text-foreground"
                  }
                >
                  {step.step}
                </span>
              </div>
            ))}
          </div>
          {/* Output log */}
          <JobOutputLog lines={job.output} />
        </div>
      )}
    </div>
  );
}

export function JobCenter({ onNavigateToPR }: JobCenterProps) {
  const { data: jobs } = useJobs();
  const [isOpen, setIsOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const activeJobs = (jobs ?? []).filter((j) => !dismissed.has(j.id));
  const runningCount = activeJobs.filter((j) => j.status === "running").length;

  // Auto-open when a new running job appears
  const prevRunningRef = useRef(0);
  useEffect(() => {
    if (runningCount > prevRunningRef.current && runningCount > 0) {
      setIsOpen(true);
    }
    prevRunningRef.current = runningCount;
  }, [runningCount]);

  // Nothing to show
  if (activeJobs.length === 0 && !isOpen) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {/* Expanded panel */}
      {isOpen && activeJobs.length > 0 && (
        <div className="w-80 max-h-[420px] rounded-lg border border-border bg-card shadow-2xl overflow-hidden flex flex-col">
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium">
                Jobs
                {runningCount > 0 && (
                  <span className="ml-1.5 text-primary">
                    {runningCount} running
                  </span>
                )}
              </span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-0.5 rounded hover:bg-muted"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>

          {/* Job list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {activeJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onNavigate={() => {
                  onNavigateToPR(job.repo, job.prNumber);
                }}
              />
            ))}
          </div>

          {/* Clear completed */}
          {activeJobs.some((j) => j.status !== "running") && (
            <div className="px-3 py-1.5 border-t border-border">
              <button
                onClick={() => {
                  const done = activeJobs
                    .filter((j) => j.status !== "running")
                    .map((j) => j.id);
                  setDismissed((prev) => {
                    const next = new Set(prev);
                    for (const id of done) next.add(id);
                    return next;
                  });
                }}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                Clear completed
              </button>
            </div>
          )}
        </div>
      )}

      {/* Floating trigger button */}
      {(activeJobs.length > 0 || isOpen) && (
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-2 rounded-full px-3 py-2 border shadow-lg transition-all ${
            runningCount > 0
              ? "border-primary/30 bg-primary/10 hover:bg-primary/20"
              : "border-border bg-card hover:bg-muted"
          }`}
        >
          {runningCount > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <Activity className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">
            {runningCount > 0
              ? `${runningCount} running`
              : `${activeJobs.length} job${activeJobs.length !== 1 ? "s" : ""}`}
          </span>
        </button>
      )}
    </div>
  );
}
