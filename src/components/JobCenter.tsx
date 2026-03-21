import { useState, useRef, useEffect, useReducer } from "react";
import { useJobs, type Job, type JobType, type ScheduledEvent } from "../hooks/useJobs";
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
  RefreshCw,
  FolderSync,
  Bot,
  Cpu,
  Search,
  Clock,
  Timer,
} from "lucide-react";

interface JobCenterProps {
  onNavigateToPR: (repo: string, prNumber: number) => void;
}

// --- Icons ---

function JobStatusIcon({ job }: { job: Job }) {
  if (job.status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />;
  }
  if (job.status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  }
  return <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />;
}

const typeIcons: Record<JobType, React.ReactNode> = {
  analyze: <Sparkles className="h-3 w-3 shrink-0 text-violet-400" />,
  fix: <Wrench className="h-3 w-3 shrink-0 text-orange-400" />,
  review: <Bot className="h-3 w-3 shrink-0 text-blue-400" />,
  poll: <RefreshCw className="h-3 w-3 shrink-0 text-muted-foreground" />,
  sync: <FolderSync className="h-3 w-3 shrink-0 text-cyan-400" />,
  refresh: <Search className="h-3 w-3 shrink-0 text-muted-foreground" />,
  score_extract: <Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />,
};

const typeLabels: Record<JobType, string> = {
  analyze: "Analyze",
  fix: "Fix",
  review: "Review",
  poll: "Poll",
  sync: "Sync",
  refresh: "Refresh",
  score_extract: "Score",
};

// --- Helpers ---

function formatDuration(startedAt: string, finishedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function formatCountdown(nextRunAt: string): string {
  const diff = new Date(nextRunAt).getTime() - Date.now();
  if (diff <= 0) return "now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function formatInterval(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `every ${mins}m`;
  const hours = Math.floor(mins / 60);
  return `every ${hours}h`;
}

function shortRepo(repo: string): string {
  const parts = repo.split("/");
  return parts[parts.length - 1];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// --- Sub-components ---

function JobOutputLog({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  if (lines.length === 0) return null;
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

function ScheduledEventCard({ event }: { event: ScheduledEvent }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/30 border border-border/50">
      <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] text-foreground">
          {event.description}
        </span>
        {event.lastRunAt && (
          <span className="text-[10px] text-muted-foreground ml-1.5">
            (last: {timeAgo(event.lastRunAt)})
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Timer className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] font-medium tabular-nums text-primary">
          {formatCountdown(event.nextRunAt)}
        </span>
      </div>
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
        : "border-green-500/20";

  const bgColor =
    job.status === "running"
      ? "bg-primary/5"
      : job.status === "error"
        ? "bg-destructive/5"
        : "bg-transparent";

  const label = job.prNumber
    ? `${shortRepo(job.repo)} #${job.prNumber}`
    : shortRepo(job.repo);

  const hasDetails = job.steps.length > 0 || job.output.length > 0;

  return (
    <div className={`rounded-md border ${statusColor} ${bgColor} p-2.5 transition-all`}>
      {/* Header row */}
      <div className="flex items-center gap-2">
        <JobStatusIcon job={job} />
        <button
          onClick={onNavigate}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:underline"
        >
          {typeIcons[job.type]}
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            {typeLabels[job.type]}
          </span>
          <span className="text-xs font-medium truncate">
            {label}
          </span>
          {job.reviewerId && (
            <span className="text-[10px] text-muted-foreground">
              ({job.reviewerId})
            </span>
          )}
        </button>
        <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
          {formatDuration(job.startedAt, job.finishedAt)}
        </span>
        {hasDetails && (
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

      {/* Detail */}
      {(job.detail || job.currentStep) && (
        <p className="text-[10px] text-muted-foreground mt-1 ml-5.5 truncate">
          {job.detail || job.currentStep}
        </p>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 ml-5.5">
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
          <JobOutputLog lines={job.output} />
        </div>
      )}
    </div>
  );
}

// --- Section header ---

function SectionHeader({ label, count }: { label: string; count: number }) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2 px-1 pt-2 pb-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-[10px] tabular-nums text-muted-foreground/50">{count}</span>
    </div>
  );
}

// --- Main component ---

export function JobCenter({ onNavigateToPR }: JobCenterProps) {
  const { data: feed } = useJobs();
  const [isOpen, setIsOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Force re-render every second while the popover is open so countdowns/durations stay live
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isOpen]);

  const allJobs = (feed?.jobs ?? []).filter((j) => !dismissed.has(j.id));
  const scheduled = feed?.scheduled ?? [];
  const running = allJobs.filter((j) => j.status === "running");
  const recent = allJobs.filter((j) => j.status !== "running");
  const totalItems = running.length + recent.length + scheduled.length;

  // Auto-open when a new running job appears
  const prevRunningRef = useRef(0);
  useEffect(() => {
    if (running.length > prevRunningRef.current && running.length > 0) {
      setIsOpen(true);
    }
    prevRunningRef.current = running.length;
  }, [running.length]);

  if (totalItems === 0 && !isOpen) return null;

  // Border + glow states
  const isRunning = running.length > 0;
  const hasScheduled = scheduled.length > 0;

  const barBorder = isRunning
    ? "border-primary/50"
    : hasScheduled
      ? "border-primary/20"
      : "border-border";

  const barBg = isRunning
    ? "bg-primary/10 hover:bg-primary/15"
    : hasScheduled
      ? "bg-card hover:bg-muted/60"
      : "border-border bg-card hover:bg-muted";

  const popoverBorder = isRunning
    ? "border-primary/40"
    : hasScheduled
      ? "border-primary/20"
      : "border-border";

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 flex flex-col">
      {/* Popover — slides up and fades in above the trigger bar */}
      <div
        className={[
          `mb-2 rounded-lg border ${popoverBorder} bg-card shadow-2xl overflow-hidden flex flex-col`,
          "transition-all duration-200 ease-out origin-bottom",
          isOpen
            ? "max-h-[560px] opacity-100 translate-y-0"
            : "max-h-0 opacity-0 translate-y-2 pointer-events-none",
        ].join(" ")}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium">Activity</span>
            {running.length > 0 && (
              <span className="text-xs text-primary font-medium">
                {running.length} running
              </span>
            )}
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="p-0.5 rounded hover:bg-muted"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5 max-h-[480px]">
          {/* Scheduled events (upcoming) */}
          {scheduled.length > 0 && (
            <>
              <SectionHeader label="Upcoming" count={scheduled.length} />
              {scheduled.map((event) => (
                <ScheduledEventCard key={event.id} event={event} />
              ))}
            </>
          )}

          {/* Running jobs */}
          {running.length > 0 && (
            <>
              <SectionHeader label="Running" count={running.length} />
              {running.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onNavigate={() => {
                    if (job.prNumber) onNavigateToPR(job.repo, job.prNumber);
                  }}
                />
              ))}
            </>
          )}

          {/* Recent (completed/failed) */}
          {recent.length > 0 && (
            <>
              <SectionHeader label="Recent" count={recent.length} />
              {recent.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onNavigate={() => {
                    if (job.prNumber) onNavigateToPR(job.repo, job.prNumber);
                  }}
                />
              ))}
            </>
          )}

          {totalItems === 0 && (
            <div className="py-4 text-center text-[11px] text-muted-foreground">
              No activity
            </div>
          )}
        </div>

        {/* Clear completed */}
        {recent.length > 0 && (
          <div className="px-3 py-1.5 border-t border-border">
            <button
              onClick={() => {
                const ids = recent.map((j) => j.id);
                setDismissed((prev) => {
                  const next = new Set(prev);
                  for (const id of ids) next.add(id);
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

      {/* Trigger bar — full width, matches popover */}
      {(totalItems > 0 || isOpen) && (
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={[
            `w-full flex items-center gap-2 rounded-lg px-4 py-2.5 border transition-all ${barBorder} ${barBg}`,
            isRunning ? "animate-breathe" : "shadow-lg",
          ].join(" ")}
          style={isRunning ? { "--breathe-color": "rgba(109, 91, 247, 0.35)" } as React.CSSProperties : undefined}
        >
          {running.length > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <Activity className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">
            {running.length > 0
              ? `${running.length} running`
              : `${totalItems} event${totalItems !== 1 ? "s" : ""}`}
          </span>
          {/* Show next scheduled countdown in the bar */}
          {scheduled.length > 0 && !isOpen && (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              next sync {formatCountdown(scheduled[0].nextRunAt)}
            </span>
          )}
          <ChevronUp
            className={[
              "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
              isOpen ? "" : "rotate-180",
              scheduled.length > 0 && !isOpen ? "" : "ml-auto",
            ].join(" ")}
          />
        </button>
      )}
    </div>
  );
}
