import { useState, useRef, useEffect, useReducer } from "react";
import { useJobs, type Job, type JobType, type ScheduledEvent } from "../hooks/useJobs";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";
import { Badge } from "./ui/badge";
import {
  Loader2,
  Check,
  AlertCircle,
  Sparkles,
  Wrench,
  ChevronDown,
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
  lastPollAt?: string | null;
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
  coordinator: <Activity className="h-3 w-3 shrink-0 text-amber-400" />,
};

const typeLabels: Record<JobType, string> = {
  analyze: "Analyze",
  fix: "Fix",
  review: "Review",
  poll: "Poll",
  sync: "Sync",
  refresh: "Refresh",
  score_extract: "Score",
  coordinator: "Coordinator",
};

function jobTypeIcon(job: Job): React.ReactNode {
  if (job.reviewerId === "claude" || job.reviewerId === "codex") {
    return <AgentLogo agent={job.reviewerId} className="h-3 w-3 shrink-0" />;
  }
  return typeIcons[job.type];
}

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

function formatAbsoluteTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
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
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${
            job.prNumber ? "hover:underline" : ""
          }`}
        >
          {jobTypeIcon(job)}
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            {typeLabels[job.type]}
          </span>
          <span className="text-xs font-medium truncate">
            {label}
          </span>
          {job.reviewerId && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <AgentLogo agent={job.reviewerId} className="h-2.5 w-2.5 shrink-0" />
              {getAgentLabel(job.reviewerId)}
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
            <ChevronDown
              className={`h-3 w-3 text-muted-foreground transition-transform duration-200 ${
                expanded ? "rotate-180" : ""
              }`}
            />
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

export function JobCenter({ onNavigateToPR, lastPollAt }: JobCenterProps) {
  const { data: feed } = useJobs();
  const [isOpen, setIsOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  // Force re-render while visible countdowns are on screen so times stay live.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const allJobs = (feed?.jobs ?? []).filter((j) => !dismissed.has(j.id));
  const scheduled = feed?.scheduled ?? [];
  const running = allJobs.filter((j) => j.status === "running");
  const recent = allJobs.filter((j) => j.status !== "running");
  const totalItems = running.length + recent.length + scheduled.length;
  const nextScheduled = scheduled[0] ?? null;
  const shouldTick = isOpen || running.length > 0 || scheduled.length > 0;

  useEffect(() => {
    if (!shouldTick) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [shouldTick]);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  // Auto-open when a new running job appears
  const prevRunningRef = useRef(0);
  useEffect(() => {
    if (running.length > prevRunningRef.current && running.length > 0) {
      setIsOpen(true);
    }
    prevRunningRef.current = running.length;
  }, [running.length]);

  const isRunning = running.length > 0;
  const hasScheduled = scheduled.length > 0;

  const shellBorder = isRunning
    ? "border-primary/40"
    : hasScheduled
      ? "border-primary/20"
      : "border-border";

  const shellBg = isRunning
    ? "bg-card/95"
    : hasScheduled
      ? "bg-card/90"
      : "bg-card/80";

  const headline = isRunning
    ? `${running.length} running now`
    : totalItems > 0
      ? "Queue is quiet"
      : "Waiting for activity";

  const subheadline = isRunning
    ? `${recent.length} recent${hasScheduled ? ` · next ${formatCountdown(nextScheduled!.nextRunAt)}` : ""}`
    : nextScheduled
      ? `Next check in ${formatCountdown(nextScheduled.nextRunAt)}`
      : lastPollAt
        ? `Last poll ${timeAgo(lastPollAt)}`
        : "No recent poll data";

  return (
    <div className="border-t border-border bg-card/60 p-3">
      <div
        ref={containerRef}
        className={[
          `relative overflow-visible rounded-xl border ${shellBorder} ${shellBg} transition-all duration-200`,
          isRunning ? "animate-breathe shadow-lg" : "shadow-lg shadow-black/10",
        ].join(" ")}
        style={isRunning ? { "--breathe-color": "rgba(109, 91, 247, 0.22)" } as React.CSSProperties : undefined}
      >
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={[
            "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
            isOpen ? "bg-muted/20" : "hover:bg-muted/20",
          ].join(" ")}
        >
          <div
            className={[
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors",
              isRunning
                ? "border-primary/30 bg-primary/10 text-primary"
                : hasScheduled
                  ? "border-primary/15 bg-primary/5 text-primary/80"
                  : "border-border bg-muted/40 text-muted-foreground",
            ].join(" ")}
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Activity className="h-4 w-4" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Activity Monitor
              </span>
              {isRunning ? (
                <Badge variant="default" className="shrink-0 px-1.5 py-0 text-[10px]">
                  Live
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 truncate text-sm font-medium text-foreground/95">
              {headline}
            </p>
            <p className="mt-0.5 truncate whitespace-nowrap text-[11px] text-muted-foreground">
              {subheadline}
            </p>
          </div>

          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
              isOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        <div
          className={[
            "pointer-events-none fixed bottom-0 left-[calc(340px+12px)] z-50 w-[26rem] transition-all duration-200 ease-out",
            isOpen ? "translate-x-0 opacity-100" : "translate-x-1 opacity-0",
          ].join(" ")}
        >
          <div className="pointer-events-auto overflow-hidden rounded-t-xl border border-b-0 border-border bg-card shadow-2xl shadow-black/35">
            <div className="max-h-[calc(100vh-12px)] space-y-2 overflow-y-auto p-2.5">
              <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/20 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Heartbeat
                  </p>
                  <p className="mt-1 text-xs text-foreground/90">
                    {nextScheduled ? nextScheduled.description : "No scheduled checks"}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {lastPollAt ? `Last poll ${formatAbsoluteTime(lastPollAt)}` : "No poll recorded yet"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-medium text-primary">
                    {nextScheduled ? formatCountdown(nextScheduled.nextRunAt) : "Idle"}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {nextScheduled ? formatInterval(nextScheduled.intervalMs) : "waiting"}
                  </p>
                </div>
              </div>

              <div className="max-h-[320px] space-y-0.5 overflow-y-auto pr-0.5">
                {scheduled.length > 0 && (
                  <>
                    <SectionHeader label="Upcoming" count={scheduled.length} />
                    {scheduled.map((event) => (
                      <ScheduledEventCard key={event.id} event={event} />
                    ))}
                  </>
                )}

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
                  <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-[11px] text-muted-foreground">
                    No activity yet
                  </div>
                )}
              </div>

              {recent.length > 0 && (
                <div className="flex justify-end border-t border-border/60 pt-2">
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
          </div>
        </div>
      </div>
    </div>
  );
}
