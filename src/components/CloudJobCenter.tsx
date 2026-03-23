import { useMemo, useReducer, useRef, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Activity, AlertCircle, Bot, Check, ChevronDown, FolderSync, Loader2, Search, Sparkles, Wrench } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { AgentLogo } from "./ui/agent-logo";
import { Badge } from "./ui/badge";
import { Popover } from "./ui/popover";

interface CloudJobCenterProps {
  onNavigateToPR: (repo: string, prNumber: number) => void;
  lastPollAt?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatDuration(startedAt?: string, finishedAt?: string) {
  if (!startedAt) return "pending";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function outputLines(run: { output?: string[] | null; steps?: Array<{ step: string; detail?: string; status: string }> | null }) {
  if (run.output && run.output.length > 0) {
    return run.output.slice(-8);
  }

  return (run.steps ?? []).slice(-6).map((step) => `${step.status}: ${step.step}${step.detail ? ` · ${step.detail}` : ""}`);
}

function JobStatusIcon({ status }: { status: "queued" | "claimed" | "running" | "done" | "error" | "cancelled" }) {
  if (status === "queued" || status === "claimed" || status === "running") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />;
}

function jobKindIcon(kind: string, title: string) {
  if (kind === "sync_repo") return <FolderSync className="h-3 w-3 shrink-0 text-cyan-400" />;
  if (kind === "refresh_pr") return <Search className="h-3 w-3 shrink-0 text-muted-foreground" />;
  if (kind === "analyze_comments") return <Sparkles className="h-3 w-3 shrink-0 text-violet-400" />;
  if (kind === "fix_comments") return <Wrench className="h-3 w-3 shrink-0 text-orange-400" />;
  if (kind === "request_review") return <Bot className="h-3 w-3 shrink-0 text-blue-400" />;
  if (title.toLowerCase().includes("claude")) return <AgentLogo agent="claude" className="h-3 w-3 shrink-0" />;
  if (title.toLowerCase().includes("codex")) return <AgentLogo agent="codex" className="h-3 w-3 shrink-0" />;
  return <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />;
}

function CloudJobCard({
  job,
  onNavigate,
}: {
  job: NonNullable<ReturnType<typeof useQuery<typeof api.jobs.listFeedForWorkspace>>>[number];
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const runLines = useMemo(() => outputLines(job.latestRun ?? {}), [job.latestRun]);
  const label = job.prNumber ? `${job.repoLabel ?? job.title} #${job.prNumber}` : job.repoLabel ?? job.title;
  const hasPRLink = Boolean(job.repoLabel && job.prNumber);

  return (
    <div className={`rounded-md border p-2.5 ${job.status === "error" ? "border-destructive/30 bg-destructive/5" : job.status === "running" ? "border-primary/30 bg-primary/5" : "border-border/70 bg-transparent"}`}>
      <div className="flex items-center gap-2">
        <JobStatusIcon status={job.status} />
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${hasPRLink ? "hover:underline" : ""}`}
          onClick={onNavigate}
          disabled={!hasPRLink}
        >
          {jobKindIcon(job.kind, job.title)}
          <span className="truncate text-xs font-medium">{label}</span>
        </button>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {formatDuration(job.startedAt ?? job.createdAt, job.finishedAt)}
        </span>
        {runLines.length > 0 ? (
          <button type="button" onClick={() => setExpanded((value) => !value)} className="rounded p-0.5 hover:bg-muted/50">
            <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </div>
      <p className="mt-1 ml-5.5 truncate text-[10px] text-muted-foreground">
        {job.targetMachineSlug ? `${job.targetMachineSlug} · ` : ""}{job.errorMessage ?? job.title}
      </p>
      {expanded ? (
        <div className="mt-2 ml-5.5 space-y-1 rounded bg-black/60 p-2 font-mono text-[10px] text-green-400">
          {runLines.map((line, index) => (
            <div key={`${job._id}:${index}`} className="whitespace-pre-wrap break-all leading-tight">{line}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CloudJobCenter({ onNavigateToPR, lastPollAt, open, onOpenChange }: CloudJobCenterProps) {
  const { activeWorkspaceId } = useActiveWorkspace();
  const feed = useQuery(
    api.jobs.listFeedForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [, tick] = useReducer((value: number) => value + 1, 0);
  const jobs = (feed ?? []).filter((job) => !dismissed.has(job._id));
  const running = jobs.filter((job) => job.status === "queued" || job.status === "claimed" || job.status === "running");
  const recent = jobs.filter((job) => !running.some((runningJob) => runningJob._id === job._id)).slice(0, 20);
  const shouldTick = open || running.length > 0;

  useEffect(() => {
    if (!shouldTick) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [shouldTick]);

  const prevRunningRef = useRef(0);
  useEffect(() => {
    if (running.length > prevRunningRef.current && running.length > 0) {
      onOpenChange(true);
    }
    prevRunningRef.current = running.length;
  }, [running.length, onOpenChange]);

  const headline = running.length > 0 ? `${running.length} running now` : recent.length > 0 ? "Queue is quiet" : "Waiting for activity";
  const subheadline = running.length > 0 ? `${recent.length} recent cloud jobs` : lastPollAt ? `Last sync ${timeAgo(lastPollAt)}` : "No cloud jobs yet";

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      className="min-w-0"
      contentContainerClassName="fixed bottom-1 left-[calc(340px+8px)]"
      contentClassName="max-h-[calc(100vh-0.5rem)] w-[26rem] overflow-hidden"
      content={
        <div className="space-y-2 p-2.5">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/20 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Cloud Activity
              </p>
              <p className="mt-1 text-xs text-foreground/90">
                Machine-dispatched jobs and their latest run output.
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {lastPollAt ? `Last sync ${timeAgo(lastPollAt)}` : "No repo sync recorded yet"}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs font-medium text-primary">{running.length > 0 ? "Live" : "Idle"}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{jobs.length} total jobs</p>
            </div>
          </div>

          <div className="max-h-[320px] space-y-2 overflow-y-auto pr-0.5">
            {running.length > 0 ? (
              <>
                <div className="flex items-center gap-2 px-1 pt-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Running</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/50">{running.length}</span>
                </div>
                {running.map((job) => (
                  <CloudJobCard
                    key={job._id}
                    job={job}
                    onNavigate={() => {
                      if (job.repoLabel && job.prNumber) onNavigateToPR(job.repoLabel, job.prNumber);
                    }}
                  />
                ))}
              </>
            ) : null}

            {recent.length > 0 ? (
              <>
                <div className="flex items-center gap-2 px-1 pt-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/50">{recent.length}</span>
                </div>
                {recent.map((job) => (
                  <CloudJobCard
                    key={job._id}
                    job={job}
                    onNavigate={() => {
                      if (job.repoLabel && job.prNumber) onNavigateToPR(job.repoLabel, job.prNumber);
                    }}
                  />
                ))}
              </>
            ) : null}

            {jobs.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-[11px] text-muted-foreground">
                No cloud activity yet
              </div>
            ) : null}
          </div>

          {recent.length > 0 ? (
            <div className="flex justify-end border-t border-border/60 pt-2">
              <button
                type="button"
                onClick={() => setDismissed((prev) => new Set([...prev, ...recent.map((job) => job._id)]))}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                Clear completed
              </button>
            </div>
          ) : null}
        </div>
      }
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors ${running.length > 0 ? "border-primary/40 bg-card/95 shadow-lg animate-breathe" : "border-border bg-card/80 shadow-lg shadow-black/10 hover:bg-muted/20"}`}
        style={running.length > 0 ? ({ "--breathe-color": "rgba(109, 91, 247, 0.22)" } as React.CSSProperties) : undefined}
      >
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${running.length > 0 ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted/40 text-muted-foreground"}`}>
          {running.length > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Activity</span>
            {running.length > 0 ? <Badge variant="default" className="shrink-0 px-1.5 py-0 text-[10px]">Live</Badge> : null}
          </div>
          <p className="truncate text-xs font-medium text-foreground/95">{headline}</p>
          <p className="truncate text-[10px] text-muted-foreground">{subheadline}</p>
        </div>

        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
    </Popover>
  );
}
