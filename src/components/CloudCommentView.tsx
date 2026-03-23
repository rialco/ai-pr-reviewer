import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, Check, ChevronDown, ChevronRight, Clock3, ExternalLink, FileCode, GitBranch, GitCommitHorizontal, Github, History, Loader2, MessageSquareReply, Minus, Plus, RefreshCw, Sparkles, Trash2, Upload, Users, Wrench, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { MarkdownBody } from "./MarkdownBody";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SectionHeader } from "./ui/section-header";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";
import { ConfirmDialog } from "./ui/confirm-dialog";

interface CloudCommentViewProps {
  repo: string;
  prNumber: number;
}

type TimelineHistoryStep = {
  step: string;
  status: "active" | "done" | "error";
  detail?: string;
  ts: string;
};

type TimelineRunHistory = {
  status?: string;
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  detail?: string;
  steps: TimelineHistoryStep[];
  output: string[];
};

type CommentFilter =
  | "all"
  | "pending"
  | "must_fix"
  | "should_fix"
  | "nice_to_have"
  | "fix_failed"
  | "fixed"
  | "already_addressed"
  | "dismissed"
  | "other";

type CommentFilterTab = {
  value: CommentFilter;
  label: string;
  count: number;
};

const categoryVariant: Record<string, "must_fix" | "should_fix" | "nice_to_have" | "dismiss" | "already_addressed"> = {
  MUST_FIX: "must_fix",
  SHOULD_FIX: "should_fix",
  NICE_TO_HAVE: "nice_to_have",
  DISMISS: "dismiss",
  ALREADY_ADDRESSED: "already_addressed",
};

const categoryLabel: Record<string, string> = {
  MUST_FIX: "Must Fix",
  SHOULD_FIX: "Should Fix",
  NICE_TO_HAVE: "Nice to Have",
  DISMISS: "Dismissed by Analysis",
  ALREADY_ADDRESSED: "Already Addressed",
  UNTRIAGED: "Pending Triage",
};

type TimelineDisplayItem =
  | {
      key: string;
      kind: "suggested";
      title: string;
      description: string;
      icon: typeof Sparkles;
      buttonLabel?: string;
      tone: "warning" | "info" | "success" | "neutral";
      onClick?: () => void;
      disabled?: boolean;
    }
  | {
      key: string;
      kind: "event";
      title: string;
      description: string | null;
      meta?: string | null;
      icon: typeof Sparkles;
      color: string;
      tone: "pending" | "success" | "error" | "info" | "neutral";
      toneLabel: string;
      event: {
        _id: string;
        createdAt: string;
        debugDetail?: unknown;
      };
      isLatest: boolean;
    };

const timelineEventConfig: Record<
  string,
  {
    icon: typeof Sparkles;
    label: string;
    color: string;
    tone: "pending" | "success" | "error" | "info" | "neutral";
    toneLabel: string;
  }
> = {
  refresh_requested: { icon: RefreshCw, label: "Refresh requested", color: "text-sky-300", tone: "pending", toneLabel: "Queued" },
  refresh_failed: { icon: X, label: "Refresh failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  comments_fetched: { icon: RefreshCw, label: "Comments synced", color: "text-blue-400", tone: "success", toneLabel: "Success" },
  analysis_requested: { icon: Sparkles, label: "Analysis requested", color: "text-violet-400", tone: "pending", toneLabel: "Queued" },
  analysis_failed: { icon: X, label: "Analysis failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  comments_analyzed: { icon: Sparkles, label: "Comments analyzed", color: "text-violet-400", tone: "success", toneLabel: "Success" },
  fix_started: { icon: Wrench, label: "Fix started", color: "text-yellow-400", tone: "pending", toneLabel: "Queued" },
  fix_completed: { icon: Check, label: "Fix committed", color: "text-emerald-400", tone: "success", toneLabel: "Success" },
  fix_no_changes: { icon: AlertCircle, label: "Fix — no changes", color: "text-muted-foreground", tone: "neutral", toneLabel: "No changes" },
  fix_failed: { icon: X, label: "Fix failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  local_fix_started: { icon: Wrench, label: "Local fix started", color: "text-yellow-400", tone: "pending", toneLabel: "Queued" },
  local_fix_completed: { icon: Check, label: "Local fix committed", color: "text-emerald-400", tone: "success", toneLabel: "Success" },
  local_fix_no_changes: { icon: AlertCircle, label: "Local fix — no changes", color: "text-muted-foreground", tone: "neutral", toneLabel: "No changes" },
  local_fix_failed: { icon: X, label: "Local fix failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  review_requested: { icon: Users, label: "Review requested", color: "text-blue-400", tone: "pending", toneLabel: "Queued" },
  review_completed: { icon: Users, label: "Review completed", color: "text-emerald-400", tone: "success", toneLabel: "Success" },
  review_failed: { icon: X, label: "Review failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  comments_replied: { icon: MessageSquareReply, label: "Replied on GitHub", color: "text-emerald-400", tone: "success", toneLabel: "Success" },
  comments_reply_failed: { icon: X, label: "Reply posting failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  review_publish_requested: { icon: Upload, label: "Review publish requested", color: "text-blue-400", tone: "pending", toneLabel: "Queued" },
  review_published: { icon: Upload, label: "Review published", color: "text-emerald-400", tone: "success", toneLabel: "Success" },
  review_publish_failed: { icon: X, label: "Review publish failed", color: "text-destructive", tone: "error", toneLabel: "Failed" },
  comment_recategorized: { icon: Sparkles, label: "Comment recategorized", color: "text-sky-300", tone: "info", toneLabel: "Updated" },
};


function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function formatRelativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(startDate: string, endDate: string) {
  const totalSeconds = Math.max(0, Math.floor((new Date(endDate).getTime() - new Date(startDate).getTime()) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getTimelineRunHistory(debugDetail: Record<string, unknown> | null) {
  const raw = debugDetail?.history;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TimelineRunHistory>;
  if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.output) || typeof candidate.startedAt !== "string") {
    return null;
  }
  return candidate as TimelineRunHistory;
}

function getTimelineConfig(eventType: string) {
  return (
    timelineEventConfig[eventType] ?? {
      icon: History,
      label: eventType.replaceAll("_", " "),
      color: "text-muted-foreground",
      tone: "neutral" as const,
      toneLabel: "Event",
    }
  );
}

function getTimelineToneClasses(tone: "pending" | "success" | "error" | "info" | "neutral") {
  switch (tone) {
    case "pending":
      return {
        card: "border-sky-400/18 bg-sky-400/6",
        icon: "border-sky-400/20 bg-sky-400/10 text-sky-300",
        badge: "border-sky-400/25 bg-sky-400/12 text-sky-200",
        connector: "bg-sky-400/18",
      };
    case "success":
      return {
        card: "border-emerald-400/18 bg-emerald-400/6",
        icon: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
        badge: "border-emerald-400/25 bg-emerald-400/12 text-emerald-200",
        connector: "bg-emerald-400/18",
      };
    case "error":
      return {
        card: "border-rose-400/20 bg-rose-400/7",
        icon: "border-rose-400/20 bg-rose-400/10 text-rose-300",
        badge: "border-rose-400/25 bg-rose-400/12 text-rose-200",
        connector: "bg-rose-400/18",
      };
    case "info":
      return {
        card: "border-violet-400/18 bg-violet-400/6",
        icon: "border-violet-400/20 bg-violet-400/10 text-violet-300",
        badge: "border-violet-400/25 bg-violet-400/12 text-violet-200",
        connector: "bg-violet-400/18",
      };
    default:
      return {
        card: "border-border bg-surface/60",
        icon: "border-border/80 bg-background/90 text-muted-foreground",
        badge: "border-border bg-background/70 text-muted-foreground",
        connector: "bg-foreground/20",
      };
  }
}

function joinMeta(items: string[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  return items.join(", ");
}

function AgentInlineLabel({
  agent,
  prefix,
  className,
}: {
  agent: "claude" | "codex";
  prefix?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <AgentLogo agent={agent} className="h-3.5 w-3.5 shrink-0" />
      <span>
        {prefix ? `${prefix} ` : ""}
        {getAgentLabel(agent)}
      </span>
    </span>
  );
}

function AnalysisDetailsPanel({
  analysisReasoning,
  analysisDetails,
  suggestion,
}: {
  analysisReasoning?: string | null;
  analysisDetails?: {
    verdict?: string | null;
    severity?: string | null;
    confidence?: number | null;
    accessMode?: string | null;
    evidence?: {
      filesRead?: string[];
      symbolsChecked?: string[];
      callersChecked?: string[];
      testsChecked?: string[];
      riskSummary?: string;
      validationNotes?: string;
    } | null;
  } | null;
  suggestion?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!analysisReasoning && !analysisDetails && !suggestion) return null;

  return (
    <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-100/90">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
            Analysis
          </p>
          {analysisDetails?.severity ? (
            <Badge variant={categoryVariant[analysisDetails.severity] ?? "outline"}>
              {categoryLabel[analysisDetails.severity] ?? analysisDetails.severity}
            </Badge>
          ) : null}
          {analysisDetails?.confidence != null ? (
            <Badge variant="outline">Confidence {analysisDetails.confidence}/5</Badge>
          ) : null}
        </div>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-emerald-300/70" /> : <ChevronRight className="h-3.5 w-3.5 text-emerald-300/70" />}
      </button>

      {expanded ? (
        <>
          {analysisReasoning ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{analysisReasoning}</p>
          ) : null}

          {analysisDetails ? (
            <div className="mt-3 rounded border border-emerald-500/15 bg-black/10 p-3 text-xs text-emerald-100/80">
              <div className="flex flex-wrap gap-2">
                {analysisDetails.severity ? (
                  <Badge variant={categoryVariant[analysisDetails.severity] ?? "outline"}>
                    {categoryLabel[analysisDetails.severity] ?? analysisDetails.severity}
                  </Badge>
                ) : null}
                {analysisDetails.confidence != null ? (
                  <Badge variant="outline">Confidence {analysisDetails.confidence}/5</Badge>
                ) : null}
                {analysisDetails.verdict ? (
                  <Badge variant="outline">{analysisDetails.verdict}</Badge>
                ) : null}
                {analysisDetails.accessMode ? (
                  <Badge variant="outline">
                    {analysisDetails.accessMode === "FULL_CODEBASE" ? "Full Codebase" : "Diff Only"}
                  </Badge>
                ) : null}
              </div>

              {analysisDetails.evidence?.riskSummary ? (
                <p className="mt-2"><span className="font-medium text-foreground">Risk:</span> {analysisDetails.evidence.riskSummary}</p>
              ) : null}
              {analysisDetails.evidence?.validationNotes ? (
                <p className="mt-1"><span className="font-medium text-foreground">Limitations:</span> {analysisDetails.evidence.validationNotes}</p>
              ) : null}
              {joinMeta(analysisDetails.evidence?.filesRead) ? (
                <p className="mt-1"><span className="font-medium text-foreground">Files:</span> {joinMeta(analysisDetails.evidence?.filesRead)}</p>
              ) : null}
              {joinMeta(analysisDetails.evidence?.symbolsChecked) ? (
                <p className="mt-1"><span className="font-medium text-foreground">Symbols:</span> {joinMeta(analysisDetails.evidence?.symbolsChecked)}</p>
              ) : null}
              {joinMeta(analysisDetails.evidence?.callersChecked) ? (
                <p className="mt-1"><span className="font-medium text-foreground">Callers:</span> {joinMeta(analysisDetails.evidence?.callersChecked)}</p>
              ) : null}
              {joinMeta(analysisDetails.evidence?.testsChecked) ? (
                <p className="mt-1"><span className="font-medium text-foreground">Tests:</span> {joinMeta(analysisDetails.evidence?.testsChecked)}</p>
              ) : null}
            </div>
          ) : null}

          {suggestion ? (
            <div className="mt-3 rounded border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-sky-100/85">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">
                Suggested Change
              </p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                {suggestion}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ReviewerSignalPanel({
  reviewSeverity,
  reviewConfidence,
  reviewEvidence,
}: {
  reviewSeverity?: string | null;
  reviewConfidence?: number | null;
  reviewEvidence?: {
    filesRead?: string[];
    changedLinesChecked?: string[];
    ruleReferences?: string[];
    riskSummary?: string;
  } | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!reviewSeverity && reviewConfidence == null && !reviewEvidence) return null;

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-xs text-muted-foreground space-y-1.5">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline">Reviewer Signal</Badge>
          {reviewSeverity ? <Badge variant="outline">{reviewSeverity}</Badge> : null}
          {reviewConfidence != null ? <Badge variant="outline">Confidence {reviewConfidence}/5</Badge> : null}
        </div>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/70" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/70" />}
      </button>
      {expanded ? (
        <>
          {reviewEvidence?.riskSummary ? (
            <div><span className="font-medium text-foreground">Risk:</span> {reviewEvidence.riskSummary}</div>
          ) : null}
          {joinMeta(reviewEvidence?.filesRead) ? (
            <div><span className="font-medium text-foreground">Files:</span> {joinMeta(reviewEvidence?.filesRead)}</div>
          ) : null}
          {joinMeta(reviewEvidence?.changedLinesChecked) ? (
            <div><span className="font-medium text-foreground">Changed lines:</span> {joinMeta(reviewEvidence?.changedLinesChecked)}</div>
          ) : null}
          {joinMeta(reviewEvidence?.ruleReferences) ? (
            <div><span className="font-medium text-foreground">References:</span> {joinMeta(reviewEvidence?.ruleReferences)}</div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TimelineCard({
  events,
  suggestion,
  onViewDetails,
}: {
  events: Array<{ _id: string; eventType: string; detail: Record<string, unknown>; createdAt: string; debugDetail?: unknown }>;
  suggestion: TimelineDisplayItem | null;
  onViewDetails: (eventId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo<TimelineDisplayItem[]>(() => {
    const eventItems = events.map((event, index) => {
      const config = getTimelineConfig(event.eventType);
      return {
        key: event._id,
        kind: "event" as const,
        title: config.label,
        description: formatTimelineDetail(event),
        meta: `${formatRelativeTime(event.createdAt)} • ${formatTimestamp(event.createdAt)}`,
        icon: config.icon,
        color: config.color,
        tone: config.tone,
        toneLabel: config.toneLabel,
        event,
        isLatest: index === 0,
      };
    });
    return suggestion ? [suggestion, ...eventItems] : eventItems;
  }, [events, suggestion]);
  const visible = expanded ? items : items.slice(0, 6);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <SectionHeader
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        title="Timeline"
        detail={(
          <span className="ml-auto flex items-center gap-2">
            <History className="h-3.5 w-3.5 text-muted-foreground/60" />
            {events.length} event{events.length !== 1 ? "s" : ""}
            <ChevronDown className={cn("h-3 w-3 text-muted-foreground/40 transition-transform duration-200", expanded && "rotate-180")} />
          </span>
        )}
        pipClassName="bg-primary/70"
        interactive
      />
      <div className="divide-y divide-border/50">
        {visible.map((item, index) => {
          if (item.kind === "suggested") {
            const Icon = item.icon;
            const toneClass = {
              warning: "border-amber-400/20 bg-amber-400/6",
              info: "border-sky-400/20 bg-sky-400/6",
              success: "border-emerald-400/20 bg-emerald-400/6",
              neutral: "border-border bg-surface/70",
            }[item.tone];
            const toneAccent = {
              warning: "text-amber-300",
              info: "text-sky-300",
              success: "text-emerald-300",
              neutral: "text-muted-foreground",
            }[item.tone];
            return (
              <div key={item.key} className="px-3 py-3">
                <div className={cn("rounded-xl border px-3.5 py-3", toneClass)}>
                  <div className="flex items-start gap-3">
                    <div className={cn("rounded-lg border border-current/10 bg-background/60 p-2", toneAccent)}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("text-[10px] font-semibold uppercase tracking-[0.16em]", toneAccent)}>Suggested next step</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                        <span className="text-sm font-medium text-foreground/92">{item.title}</span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground/85">{item.description}</p>
                    </div>
                    {item.buttonLabel && item.onClick ? (
                      <Button size="sm" className="h-8 shrink-0" onClick={item.onClick} disabled={item.disabled}>
                        {item.buttonLabel}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          }

          const Icon = item.icon;
          const previousItem = visible[index - 1];
          const nextItem = visible[index + 1];
          const hasPreviousConnection = previousItem?.kind === "event";
          const hasNextConnection = nextItem?.kind === "event";
          const toneClasses = getTimelineToneClasses(item.tone);

          return (
            <div key={item.key} className={cn("flex gap-3 px-3 py-3 transition-opacity duration-200", item.isLatest ? "opacity-100" : "opacity-45 hover:opacity-80")}>
              <div className="relative flex w-8 shrink-0 justify-center">
                {hasPreviousConnection ? <span className={cn("absolute left-1/2 top-[-12px] h-[16px] w-px -translate-x-1/2", toneClasses.connector)} /> : null}
                {hasNextConnection ? <span className={cn("absolute left-1/2 top-8 bottom-[-12px] w-px -translate-x-1/2", toneClasses.connector)} /> : null}
                <div className={cn("relative z-10 mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border", toneClasses.icon, item.isLatest ? "shadow-[0_0_0_1px_rgba(255,255,255,0.04)]" : undefined, item.color)}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
              </div>
              <div className={cn("min-w-0 flex-1 rounded-xl border px-3 py-2.5", toneClasses.card)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-foreground/92">{item.title}</span>
                  <Badge variant="outline" className={cn("h-4 px-1.5 text-[9px] uppercase tracking-wide", toneClasses.badge)}>
                    {item.toneLabel}
                  </Badge>
                  {item.isLatest ? <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase tracking-wide">Latest</Badge> : null}
                </div>
                {item.meta ? (
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/62">
                    <Clock3 className="h-3 w-3 shrink-0" />
                    <span>{item.meta}</span>
                  </p>
                ) : null}
                {item.description ? <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground/75">{item.description}</p> : null}
              </div>
              {item.event.debugDetail ? (
                <Button variant="outline" size="sm" className="h-6 shrink-0 gap-1.5 px-2 text-[10px]" onClick={() => onViewDetails(item.event._id)}>
                  <FileCode className="h-3 w-3" />
                  View details
                </Button>
              ) : null}
            </div>
          );
        })}
        {items.length > 6 && !expanded ? (
          <div className="border-t border-border/50 px-3 py-1">
            <button onClick={() => setExpanded(true)} className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
              Show {items.length - 6} more...
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CommentTypeBadge({ type }: { type: "inline" | "review" | "issue_comment" }) {
  const label =
    type === "inline" ? "Inline comment" : type === "review" ? "Review note" : "Issue comment";

  return <Badge variant="outline">{label}</Badge>;
}

function timelineLabel(eventType: string) {
  if (eventType === "comment_recategorized") return "Comment recategorized";
  if (eventType === "refresh_requested") return "Refresh requested";
  if (eventType === "refresh_failed") return "Refresh failed";
  if (eventType === "comments_fetched") return "GitHub snapshot updated";
  if (eventType === "analysis_requested") return "Review comment analysis requested";
  if (eventType === "analysis_failed") return "Review comment analysis failed";
  if (eventType === "fix_started") return "GitHub comment fix requested";
  if (eventType === "fix_completed") return "GitHub comment fix completed";
  if (eventType === "fix_failed") return "GitHub comment fix failed";
  if (eventType === "fix_no_changes") return "GitHub comment fix made no changes";
  if (eventType === "comments_replied") return "Replies posted";
  if (eventType === "comments_reply_failed") return "Reply posting failed";
  if (eventType === "review_publish_requested") return "Review publish requested";
  if (eventType === "review_published") return "Review published";
  if (eventType === "review_publish_failed") return "Review publish failed";
  if (eventType === "review_failed") return "Review failed";
  if (eventType === "local_fix_started") return "Local fix requested";
  if (eventType === "local_fix_completed") return "Local fix completed";
  if (eventType === "local_fix_failed") return "Local fix failed";
  if (eventType === "local_fix_no_changes") return "Local fix made no changes";
  return eventType.replaceAll("_", " ");
}

function localAgentLabel(agent: string | undefined) {
  if (agent === "claude") return "Claude Code";
  if (agent === "codex") return "Codex";
  return agent ?? "Unknown";
}

function scoreAccent(score: number | null | undefined) {
  if (score == null) return "text-muted-foreground/60";
  if (score >= 4) return "text-emerald-400";
  if (score >= 3) return "text-amber-400";
  return "text-rose-400";
}

function formatTimelineDetail(event: { eventType: string; detail: Record<string, unknown> }) {
  const d = event.detail;
  switch (event.eventType) {
    case "refresh_failed":
      return typeof d.errorMessage === "string" ? d.errorMessage.split("\n")[0] : "Refresh did not complete";
    case "comments_fetched":
      return `${typeof d.machineSlug === "string" ? d.machineSlug : "worker"} synced ${typeof d.commentCount === "number" ? d.commentCount : 0} comment(s)`;
    case "analysis_requested":
      return `${localAgentLabel(typeof d.analyzerAgent === "string" ? d.analyzerAgent : undefined)} queued ${typeof d.count === "number" ? d.count : 0} comment(s)`;
    case "analysis_failed":
      return typeof d.errorMessage === "string" ? d.errorMessage.split("\n")[0] : "Analysis did not complete";
    case "comments_analyzed": {
      if (d.categories && typeof d.categories === "object") {
        const parts = Object.entries(d.categories as Record<string, number>).map(
          ([key, value]) => `${value} ${key.replaceAll("_", " ").toLowerCase()}`,
        );
        return `${localAgentLabel(typeof d.analyzerAgent === "string" ? d.analyzerAgent : undefined)} • ${parts.join(", ")}`;
      }
      return `${typeof d.count === "number" ? d.count : 0} comment(s) analyzed`;
    }
    case "fix_started":
    case "local_fix_started":
      return `${localAgentLabel(typeof d.fixerAgent === "string" ? d.fixerAgent : undefined)} queued ${typeof d.commentCount === "number" ? d.commentCount : 0} comment(s)`;
    case "fix_completed":
    case "local_fix_completed":
      return `${localAgentLabel(typeof d.fixerAgent === "string" ? d.fixerAgent : undefined)} committed ${typeof d.commitHash === "string" ? d.commitHash.slice(0, 12) : "changes"}`;
    case "fix_failed":
    case "local_fix_failed":
      return typeof d.errorMessage === "string" ? d.errorMessage.split("\n")[0] : "Fix did not complete";
    case "fix_no_changes":
    case "local_fix_no_changes":
      return `${localAgentLabel(typeof d.fixerAgent === "string" ? d.fixerAgent : undefined)} produced no diff`;
    case "comments_replied":
      return `${typeof d.count === "number" ? d.count : 0} comment(s) replied`;
    case "comments_reply_failed":
      return typeof d.errorMessage === "string" ? d.errorMessage.split("\n")[0] : "Reply posting failed";
    case "review_requested":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} requested`;
    case "review_completed":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} • ${d.confidenceScore ?? "--"}/5 • ${d.commentCount ?? 0} comments`;
    case "review_failed":
      return typeof d.errorMessage === "string" ? d.errorMessage.split("\n")[0] : "Review did not complete";
    case "review_publish_requested":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} publish queued`;
    case "review_published":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} published ${typeof d.commentCount === "number" ? d.commentCount : 0} comment(s)`;
    case "review_publish_failed":
      return typeof d.errorMessage === "string" ? d.errorMessage.split("\n")[0] : "Review publish failed";
    case "comment_recategorized":
      return `Set category to ${typeof d.category === "string" ? d.category : "unknown"}`;
    default:
      return null;
  }
}

export function CloudCommentView({ repo, prNumber }: CloudCommentViewProps) {
  const { activeWorkspaceId } = useActiveWorkspace();
  const resetPrData = useMutation(api.prs.resetForWorkspace);
  const enqueuePrRefresh = useMutation(api.jobs.enqueuePrRefresh);
  const enqueueGithubCommentAnalysis = useMutation(api.jobs.enqueueGithubCommentAnalysis);
  const enqueueGithubCommentFix = useMutation(api.jobs.enqueueGithubCommentFix);
  const enqueueGithubCommentReply = useMutation(api.jobs.enqueueGithubCommentReply);
  const enqueueReviewRequest = useMutation(api.jobs.enqueueReviewRequest);
  const enqueueReviewCommentAnalysis = useMutation(api.jobs.enqueueReviewCommentAnalysis);
  const enqueueReviewCommentFix = useMutation(api.jobs.enqueueReviewCommentFix);
  const enqueueReviewPublish = useMutation(api.jobs.enqueueReviewPublish);
  const recategorizeGithubComment = useMutation(api.githubComments.recategorizeForWorkspace);
  const detail = useQuery(
    api.prs.getDetailForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, repoLabel: repo, prNumber } : "skip",
  );
  const timeline = useQuery(
    api.prs.listTimelineForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, repoLabel: repo, prNumber } : "skip",
  );
  const machineConfigs = useQuery(
    api.repos.listMachineConfigsForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const machines = useQuery(
    api.machines.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const reviews = useQuery(
    api.reviews.listForPr,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, repoLabel: repo, prNumber } : "skip",
  );
  const reviewComments = useQuery(
    api.reviews.listCommentsForPr,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, repoLabel: repo, prNumber } : "skip",
  );
  const [selectedMachineSlug, setSelectedMachineSlug] = useState<string>("");
  const [preferredActionAgent, setPreferredActionAgent] = useState<"claude" | "codex" | "">("");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [selectedTimelineEventId, setSelectedTimelineEventId] = useState<string | null>(null);
  const [timelineTab, setTimelineTab] = useState<"history" | "parameters" | "prompt">("history");
  const [selectedReviewerId, setSelectedReviewerId] = useState<"claude" | "codex" | null>(null);
  const [reviewDetailsTab, setReviewDetailsTab] = useState<"summary" | "raw">("summary");
  const [githubFilter, setGithubFilter] = useState<CommentFilter>("all");
  const [reviewFilter, setReviewFilter] = useState<CommentFilter>("all");
  const [showBody, setShowBody] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const timelineEventDetail = useQuery(
    api.prs.getTimelineEventForWorkspace,
    activeWorkspaceId && selectedTimelineEventId
      ? { workspaceId: activeWorkspaceId, eventId: selectedTimelineEventId as never }
      : "skip",
  );

  const repoMachineConfigs = useMemo(
    () => (machineConfigs ?? []).filter((config) => config.repoLabel === repo),
    [machineConfigs, repo],
  );

  useEffect(() => {
    if (repoMachineConfigs.length === 0) {
      setSelectedMachineSlug("");
      return;
    }
    if (!repoMachineConfigs.some((config) => config.machineSlug === selectedMachineSlug)) {
      setSelectedMachineSlug(repoMachineConfigs[0].machineSlug);
    }
  }, [repoMachineConfigs, selectedMachineSlug]);

  const selectedMachine = repoMachineConfigs.find((config) => config.machineSlug === selectedMachineSlug) ?? null;
  const selectedMachineRecord = machines?.find((machine) => machine.slug === selectedMachineSlug) ?? null;
  const availableAnalyzerAgents = useMemo(
    () =>
      ([
        selectedMachineRecord?.capabilities.claude ? "claude" : null,
        selectedMachineRecord?.capabilities.codex ? "codex" : null,
      ].filter(Boolean) as Array<"claude" | "codex">),
    [selectedMachineRecord],
  );
  const availableFixerAgents = availableAnalyzerAgents;
  const availableReviewAgents = useMemo(
    () =>
      ([
        selectedMachineRecord?.capabilities.claude ? "claude" : null,
        selectedMachineRecord?.capabilities.codex ? "codex" : null,
      ].filter(Boolean) as Array<"claude" | "codex">),
    [selectedMachineRecord],
  );
  const suggestedAnalyzerAgent = availableAnalyzerAgents[0] ?? null;
  const suggestedFixerAgent = availableFixerAgents[0] ?? null;

  useEffect(() => {
    if (availableAnalyzerAgents.length === 0) {
      if (preferredActionAgent !== "") {
        setPreferredActionAgent("");
      }
      return;
    }

    if (
      preferredActionAgent === "" ||
      !availableAnalyzerAgents.includes(preferredActionAgent)
    ) {
      setPreferredActionAgent(availableAnalyzerAgents[0]);
    }
  }, [availableAnalyzerAgents, preferredActionAgent]);
  const githubComments = detail?.comments ?? [];
  const pendingGithubCommentCount = useMemo(
    () =>
      githubComments.filter(
        (comment) =>
          comment.status === "new" || comment.status === "analyzing",
      ).length,
    [githubComments],
  );
  const fixableGithubCommentCount = useMemo(
    () =>
      githubComments.filter(
        (comment) =>
          (comment.status === "analyzed" || comment.status === "fix_failed") &&
          (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX"),
      ).length,
    [githubComments],
  );
  const replyableGithubCommentCount = useMemo(
    () =>
      githubComments.filter(
        (comment) =>
          comment.type === "inline" &&
          comment.status === "fixed" &&
          !comment.repliedAt &&
          !!comment.fixCommitHash,
      ).length,
    [githubComments],
  );
  const reviewerSummaries = useMemo(() => {
    const ids = ["claude", "codex"] as const;
    return ids.map((reviewerId) => {
      const latestReview =
        (reviews ?? [])
          .filter((review) => review.reviewerId === reviewerId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      const commentsForReviewer = (reviewComments ?? []).filter((comment) => comment.reviewerId === reviewerId);
      const actionableCount = commentsForReviewer.filter(
        (comment) => comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX",
      ).length;
      return {
        reviewerId,
        latestReview,
        totalComments: commentsForReviewer.length,
        actionableCount,
      };
    });
  }, [reviewComments, reviews]);
  const selectedTimelineEvent =
    timelineEventDetail ?? (timeline ?? []).find((event) => event._id === selectedTimelineEventId) ?? null;
  const selectedReviewerSummary =
    reviewerSummaries.find((summary) => summary.reviewerId === selectedReviewerId) ?? null;
  const githubPending = useMemo(
    () => githubComments.filter((comment) => comment.status === "new" || comment.status === "analyzing"),
    [githubComments],
  );
  const githubFixing = useMemo(
    () => githubComments.filter((comment) => comment.status === "fixing"),
    [githubComments],
  );
  const githubFixFailed = useMemo(
    () => githubComments.filter((comment) => comment.status === "fix_failed"),
    [githubComments],
  );
  const githubFixed = useMemo(
    () => githubComments.filter((comment) => comment.status === "fixed"),
    [githubComments],
  );
  const githubMustFix = useMemo(
    () => githubComments.filter((comment) => comment.status !== "fixed" && comment.analysisCategory === "MUST_FIX"),
    [githubComments],
  );
  const githubShouldFix = useMemo(
    () => githubComments.filter((comment) => comment.status !== "fixed" && comment.analysisCategory === "SHOULD_FIX"),
    [githubComments],
  );
  const githubNiceToHave = useMemo(
    () => githubComments.filter((comment) => comment.status !== "fixed" && comment.analysisCategory === "NICE_TO_HAVE"),
    [githubComments],
  );
  const githubAlreadyAddressed = useMemo(
    () => githubComments.filter((comment) => comment.analysisCategory === "ALREADY_ADDRESSED"),
    [githubComments],
  );
  const githubDismissedByAnalysis = useMemo(
    () => githubComments.filter((comment) => comment.analysisCategory === "DISMISS"),
    [githubComments],
  );
  const githubReanalyzableCount = useMemo(
    () => githubComments.filter((comment) => comment.status === "analyzed" || comment.status === "fix_failed" || comment.status === "fixed").length,
    [githubComments],
  );
  const reviewPending = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status === "new" || comment.status === "analyzing"),
    [reviewComments],
  );
  const reviewFixing = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status === "fixing"),
    [reviewComments],
  );
  const reviewFixFailed = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status === "fix_failed"),
    [reviewComments],
  );
  const reviewFixed = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status === "fixed"),
    [reviewComments],
  );
  const reviewMustFix = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status !== "fixed" && comment.analysisCategory === "MUST_FIX"),
    [reviewComments],
  );
  const reviewShouldFix = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status !== "fixed" && comment.analysisCategory === "SHOULD_FIX"),
    [reviewComments],
  );
  const reviewNiceToHave = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.status !== "fixed" && comment.analysisCategory === "NICE_TO_HAVE"),
    [reviewComments],
  );
  const reviewAlreadyAddressed = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.analysisCategory === "ALREADY_ADDRESSED"),
    [reviewComments],
  );
  const reviewDismissedByAnalysis = useMemo(
    () => (reviewComments ?? []).filter((comment) => comment.analysisCategory === "DISMISS"),
    [reviewComments],
  );
  const reviewReanalyzableCount = useMemo(
    () => (reviewComments ?? []).filter((comment) => !comment.supersededAt && (comment.status === "analyzed" || comment.status === "fix_failed" || comment.status === "fixed")).length,
    [reviewComments],
  );
  const reviewFixableCount = useMemo(
    () =>
      (reviewComments ?? []).filter(
        (comment) =>
          !comment.supersededAt &&
          (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX") &&
          (comment.status === "analyzed" || comment.status === "fix_failed"),
      ).length,
    [reviewComments],
  );
  const publishableReviewCount = useMemo(
    () =>
      (reviewComments ?? []).filter(
        (comment) =>
          !comment.supersededAt &&
          !comment.publishedAt &&
          comment.status === "analyzed" &&
          comment.analysisCategory !== "DISMISS" &&
          comment.analysisCategory !== "ALREADY_ADDRESSED",
      ).length,
    [reviewComments],
  );
  const githubFilterTabs = useMemo<CommentFilterTab[]>(
    () => {
      const tabs: CommentFilterTab[] = [
        { value: "all", label: "All", count: githubComments.length },
        { value: "pending", label: "Pending", count: githubPending.length },
        { value: "must_fix", label: "Must Fix", count: githubMustFix.length },
        { value: "should_fix", label: "Should Fix", count: githubShouldFix.length },
        { value: "nice_to_have", label: "Nice to Have", count: githubNiceToHave.length },
        { value: "fix_failed", label: "Fix Failed", count: githubFixFailed.length },
        { value: "fixed", label: "Fixed", count: githubFixed.length },
        { value: "already_addressed", label: "Addressed", count: githubAlreadyAddressed.length },
        { value: "dismissed", label: "Dismissed", count: githubDismissedByAnalysis.length },
      ];
      return tabs.filter((tab) => tab.value === "all" || tab.count > 0);
    },
    [
      githubAlreadyAddressed.length,
      githubComments.length,
      githubDismissedByAnalysis.length,
      githubFixed.length,
      githubFixFailed.length,
      githubMustFix.length,
      githubNiceToHave.length,
      githubPending.length,
      githubShouldFix.length,
    ],
  );
  const reviewFilterTabs = useMemo<CommentFilterTab[]>(
    () => {
      const tabs: CommentFilterTab[] = [
        { value: "all", label: "All", count: reviewComments?.length ?? 0 },
        { value: "pending", label: "Pending", count: reviewPending.length },
        { value: "must_fix", label: "Must Fix", count: reviewMustFix.length },
        { value: "should_fix", label: "Should Fix", count: reviewShouldFix.length },
        { value: "nice_to_have", label: "Nice to Have", count: reviewNiceToHave.length },
        { value: "fix_failed", label: "Fix Failed", count: reviewFixFailed.length },
        { value: "fixed", label: "Fixed", count: reviewFixed.length },
        { value: "already_addressed", label: "Addressed", count: reviewAlreadyAddressed.length },
        { value: "dismissed", label: "Dismissed", count: reviewDismissedByAnalysis.length },
      ];
      return tabs.filter((tab) => tab.value === "all" || tab.count > 0);
    },
    [
      reviewAlreadyAddressed.length,
      reviewComments?.length,
      reviewDismissedByAnalysis.length,
      reviewFixed.length,
      reviewFixFailed.length,
      reviewMustFix.length,
      reviewNiceToHave.length,
      reviewPending.length,
      reviewShouldFix.length,
    ],
  );
  const visibleGithubComments = useMemo(() => {
    switch (githubFilter) {
      case "pending":
        return githubPending;
      case "must_fix":
        return githubMustFix;
      case "should_fix":
        return githubShouldFix;
      case "nice_to_have":
        return githubNiceToHave;
      case "fix_failed":
        return githubFixFailed;
      case "fixed":
        return githubFixed;
      case "already_addressed":
        return githubAlreadyAddressed;
      case "dismissed":
        return githubDismissedByAnalysis;
      case "all":
      default:
        return [...githubComments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
  }, [
    githubAlreadyAddressed,
    githubComments,
    githubDismissedByAnalysis,
    githubFilter,
    githubFixed,
    githubFixFailed,
    githubMustFix,
    githubNiceToHave,
    githubPending,
    githubShouldFix,
  ]);
  const visibleReviewComments = useMemo(() => {
    switch (reviewFilter) {
      case "pending":
        return reviewPending;
      case "must_fix":
        return reviewMustFix;
      case "should_fix":
        return reviewShouldFix;
      case "nice_to_have":
        return reviewNiceToHave;
      case "fix_failed":
        return reviewFixFailed;
      case "fixed":
        return reviewFixed;
      case "already_addressed":
        return reviewAlreadyAddressed;
      case "dismissed":
        return reviewDismissedByAnalysis;
      case "all":
      default:
        return reviewComments ?? [];
    }
  }, [
    reviewAlreadyAddressed,
    reviewComments,
    reviewDismissedByAnalysis,
    reviewFilter,
    reviewFixed,
    reviewFixFailed,
    reviewMustFix,
    reviewNiceToHave,
    reviewPending,
    reviewShouldFix,
  ]);

  useEffect(() => {
    setTimelineTab("history");
  }, [selectedTimelineEventId]);

  useEffect(() => {
    setReviewDetailsTab("summary");
  }, [selectedReviewerId]);

  useEffect(() => {
    if (!githubFilterTabs.some((tab) => tab.value === githubFilter)) {
      setGithubFilter("all");
    }
  }, [githubFilter, githubFilterTabs]);

  useEffect(() => {
    if (!reviewFilterTabs.some((tab) => tab.value === reviewFilter)) {
      setReviewFilter("all");
    }
  }, [reviewFilter, reviewFilterTabs]);

  if (!activeWorkspaceId || detail === undefined) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading cloud PR data...
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Github className="mb-3 h-8 w-8 opacity-40" />
        <p className="text-sm">This PR is not in the cloud snapshot yet</p>
        <p className="mt-1 text-xs">Run `Sync` for this repo checkout from the sidebar to populate PR details.</p>
      </div>
    );
  }

  const { pr, comments } = detail;
  const previewFiles = pr.files.slice(0, 8);
  const extraFiles = pr.files.slice(8);
  const bodyText = pr.body.trim();
  const hasLongBody = bodyText.length > 500;

  const handleRefresh = async () => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setRefreshError(null);
      await enqueuePrRefresh({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
      });
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleResetPrData = async () => {
    if (!activeWorkspaceId || isResetting) {
      return;
    }

    try {
      setResetError(null);
      setIsResetting(true);
      await resetPrData({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
      });
      setResetDialogOpen(false);
      setSelectedTimelineEventId(null);
      setSelectedReviewerId(null);
      setGithubFilter("all");
      setReviewFilter("all");
    } catch (error) {
      setResetError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsResetting(false);
    }
  };

  const handleRequestReview = async (reviewerId: "claude" | "codex") => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setReviewError(null);
      await enqueueReviewRequest({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
        reviewerId,
      });
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRequestAllAvailableReviews = async () => {
    for (const reviewerId of availableReviewAgents) {
      await handleRequestReview(reviewerId);
    }
  };

  const handleAnalyzePendingReviewComments = async (
    analyzerAgent: "claude" | "codex",
    reanalyze = false,
  ) => {
    const reviewerIds = Array.from(
      new Set(
        (reviewComments ?? [])
          .filter((comment) => {
            if (comment.supersededAt) {
              return false;
            }
            if (reanalyze) {
              return comment.status === "analyzed" || comment.status === "fix_failed" || comment.status === "fixed";
            }
            return comment.status === "new" || comment.status === "analyzing";
          })
          .map((comment) => comment.reviewerId),
      ),
    ) as Array<"claude" | "codex">;

    for (const reviewerId of reviewerIds) {
      await handleAnalyzeReviewComments(reviewerId, analyzerAgent, reanalyze);
    }
  };

  const handleFixPendingReviewComments = async (fixerAgent: "claude" | "codex") => {
    const reviewerIds = Array.from(
      new Set(
        (reviewComments ?? [])
          .filter(
            (comment) =>
              !comment.supersededAt &&
              (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX") &&
              (comment.status === "analyzed" || comment.status === "fix_failed"),
          )
          .map((comment) => comment.reviewerId),
      ),
    ) as Array<"claude" | "codex">;

    for (const reviewerId of reviewerIds) {
      await handleFixReviewComments(reviewerId, fixerAgent);
    }
  };

  const handlePublishAvailableReviews = async () => {
    const reviewerIds = Array.from(
      new Set(
        (reviewComments ?? [])
          .filter(
            (comment) =>
              !comment.supersededAt &&
              !comment.publishedAt &&
              comment.status === "analyzed" &&
              comment.analysisCategory !== "DISMISS" &&
              comment.analysisCategory !== "ALREADY_ADDRESSED",
          )
          .map((comment) => comment.reviewerId),
      ),
    ) as Array<"claude" | "codex">;

    for (const reviewerId of reviewerIds) {
      await handlePublishReview(reviewerId);
    }
  };

  const handleAnalyzeReviewComments = async (
    reviewerId: "claude" | "codex",
    analyzerAgent: "claude" | "codex",
    reanalyze = false,
  ) => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setAnalysisError(null);
      await enqueueReviewCommentAnalysis({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
        reviewerId,
        analyzerAgent,
        reanalyze,
      });
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAnalyzeGithubComments = async (analyzerAgent: "claude" | "codex", reanalyze = false) => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setAnalysisError(null);
      await enqueueGithubCommentAnalysis({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
        analyzerAgent,
        reanalyze,
      });
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleFixReviewComments = async (
    reviewerId: "claude" | "codex",
    fixerAgent: "claude" | "codex",
  ) => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setFixError(null);
      await enqueueReviewCommentFix({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
        reviewerId,
        fixerAgent,
      });
    } catch (error) {
      setFixError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleFixGithubComments = async (fixerAgent: "claude" | "codex") => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setFixError(null);
      await enqueueGithubCommentFix({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
        fixerAgent,
      });
    } catch (error) {
      setFixError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleReplyToGithubComments = async () => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setReplyError(null);
      await enqueueGithubCommentReply({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
      });
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : String(error));
    }
  };

  const handlePublishReview = async (reviewerId: "claude" | "codex") => {
    if (!activeWorkspaceId || !selectedMachineSlug) {
      return;
    }

    try {
      setPublishError(null);
      await enqueueReviewPublish({
        workspaceId: activeWorkspaceId,
        repoLabel: repo,
        prNumber,
        machineSlug: selectedMachineSlug,
        reviewerId,
      });
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRecategorizeGithubComment = async (
    commentId: string,
    category: "MUST_FIX" | "SHOULD_FIX" | "NICE_TO_HAVE" | "DISMISS" | "ALREADY_ADDRESSED",
  ) => {
    if (!activeWorkspaceId) {
      return;
    }

    await recategorizeGithubComment({
      workspaceId: activeWorkspaceId,
      commentId: commentId as never,
      category,
    });
  };

  const suggestedTimelineStep: TimelineDisplayItem | null = !selectedMachineSlug
    ? {
        key: "suggested-select-machine",
        kind: "suggested",
        title: "Select a machine checkout",
        description: "Choose a linked machine checkout before running refresh, triage, fix, or review actions for this PR.",
        icon: Sparkles,
        tone: "neutral",
      }
    : pendingGithubCommentCount > 0 && suggestedAnalyzerAgent
      ? {
          key: "suggested-triage-github",
          kind: "suggested",
          title: "Analyze GitHub comments",
          description: "New bot review comments are waiting to be triaged before they can be fixed or replied to.",
          icon: Sparkles,
          buttonLabel: "Analyze",
          tone: "warning",
          onClick: () => void handleAnalyzeGithubComments(suggestedAnalyzerAgent),
        }
      : fixableGithubCommentCount > 0 && suggestedFixerAgent
        ? {
            key: "suggested-fix-github",
            kind: "suggested",
            title: "Fix actionable GitHub comments",
            description: "There are triaged GitHub comments ready for a local fix run.",
            icon: Wrench,
            buttonLabel: "Fix issues",
            tone: "info",
            onClick: () => void handleFixGithubComments(suggestedFixerAgent),
          }
        : replyableGithubCommentCount > 0 && selectedMachineRecord?.capabilities.gh
          ? {
              key: "suggested-reply-github",
              kind: "suggested",
              title: "Reply to fixed comments",
              description: "Some fixed inline comments are ready to be acknowledged back on GitHub.",
              icon: MessageSquareReply,
              buttonLabel: "Reply",
              tone: "success",
              onClick: () => void handleReplyToGithubComments(),
            }
          : reviewPending.length > 0 && suggestedAnalyzerAgent
            ? {
                key: "suggested-triage-local",
                kind: "suggested",
                title: "Analyze local review comments",
                description: "Review comments from local reviewers need categorization before they can be fixed or published.",
                icon: Sparkles,
                buttonLabel: "Analyze",
                tone: "warning",
                onClick: () => void handleAnalyzePendingReviewComments(suggestedAnalyzerAgent),
              }
            : availableReviewAgents.length > 0
              ? {
                  key: "suggested-request-review",
                  kind: "suggested",
                  title: availableReviewAgents.length > 1 ? "Request reviews" : `Request review with ${getAgentLabel(availableReviewAgents[0])}`,
                  description: availableReviewAgents.length > 1
                    ? "Run both local reviewers to gather actionable comments before triage and fix steps."
                    : "The fastest next step is to run a fresh local review and gather actionable comments.",
                  icon: Users,
                  buttonLabel: "Review",
                  tone: "neutral",
                  onClick: () =>
                    void (availableReviewAgents.length > 1
                      ? handleRequestAllAvailableReviews()
                      : handleRequestReview(availableReviewAgents[0])),
                }
              : null;

  return (
    <div className="relative space-y-4">
      <div className="sticky top-0 z-20 pb-1">
        <section className="relative overflow-hidden border-b border-white/6 bg-zinc-800/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md">
          <div className="px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge variant="outline">#{pr.prNumber}</Badge>
                  <Badge variant="outline">{pr.author}</Badge>
                  <span className="text-xs text-muted-foreground">Updated {formatTimestamp(pr.updatedAt)}</span>
                </div>
                <h1 className="text-xl font-semibold leading-tight text-foreground/88">{pr.title}</h1>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/90">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" />
                    {pr.baseRefName ?? "unknown"} ← {pr.headRefName ?? "unknown"}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <FileCode className="h-3.5 w-3.5" />
                    {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-emerald-400">
                    <Plus className="h-3.5 w-3.5" />
                    {pr.additions}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-rose-400">
                    <Minus className="h-3.5 w-3.5" />
                    {pr.deletions}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <GitCommitHorizontal className="h-3.5 w-3.5" />
                    {pr.commitCount} commit{pr.commitCount === 1 ? "" : "s"}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {repoMachineConfigs.length > 0 ? (
                  <>
                    <Select value={selectedMachineSlug} onValueChange={setSelectedMachineSlug}>
                      <SelectTrigger className="w-[210px] bg-black/10 text-xs">
                        <SelectValue placeholder="Choose machine" />
                      </SelectTrigger>
                      <SelectContent>
                        {repoMachineConfigs.map((config) => (
                          <SelectItem key={config._id} value={config.machineSlug}>
                            {config.machineName} · {config.machineStatus}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" disabled={!selectedMachineSlug} onClick={() => void handleRefresh()}>
                      <RefreshCw className="h-3.5 w-3.5" />
                      Refresh PR
                    </Button>
                  </>
                ) : null}
                <Button variant="destructive" size="sm" onClick={() => setResetDialogOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Reset PR data
                </Button>
                <a href={pr.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open on GitHub
                  </Button>
                </a>
              </div>
            </div>
          </div>
          {resetError ? (
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {resetError}
            </div>
          ) : null}
        </section>
      </div>

      <div className="space-y-4 px-6 pb-6 pt-4">
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
          <Card className="flex h-full flex-col overflow-hidden bg-surface">
            <SectionHeader title="Description" pipClassName="bg-muted-foreground/40" />
            <div className="flex-1 p-4">
              {bodyText ? (
                <>
                  <div className={!showBody && hasLongBody ? "max-h-64 overflow-hidden" : ""}>
                    <MarkdownBody text={bodyText} />
                  </div>
                  {hasLongBody ? (
                    <Button variant="ghost" size="sm" className="mt-2 px-2" onClick={() => setShowBody((value) => !value)}>
                      {showBody ? "Show less" : "Show full description"}
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No PR description provided.</p>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden bg-surface">
            <SectionHeader
              title="Files Changed"
              detail={`${pr.changedFiles} total`}
              pipClassName="bg-nice-to-have"
            />
            <div className="p-2">
              {previewFiles.length > 0 ? (
                <div className="space-y-1">
                  {previewFiles.map((file) => (
                    <div key={file.path} className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-muted">
                      <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/95">
                        {file.path}
                      </span>
                      <span className="shrink-0 text-[11px] text-emerald-400">+{file.additions}</span>
                      <span className="shrink-0 text-[11px] text-rose-400">-{file.deletions}</span>
                    </div>
                  ))}
                  {extraFiles.length > 0 && showAllFiles ? (
                    <div className="space-y-1 pt-1">
                      {extraFiles.map((file) => (
                        <div key={file.path} className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-muted">
                          <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/95">
                            {file.path}
                          </span>
                          <span className="shrink-0 text-[11px] text-emerald-400">+{file.additions}</span>
                          <span className="shrink-0 text-[11px] text-rose-400">-{file.deletions}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="px-2.5 py-2 text-sm text-muted-foreground">No file list available.</div>
              )}

              {extraFiles.length > 0 ? (
                <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setShowAllFiles((value) => !value)}>
                  {showAllFiles ? "Show fewer files" : `Show all ${pr.files.length} files`}
                </Button>
              ) : null}
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden bg-surface">
          <SectionHeader title="Review Confidence" pipClassName="bg-should-fix" />
          <div className="px-4 py-3">
            <div className="space-y-3">
              {reviewerSummaries.map((summary) => {
                const available = summary.reviewerId === "claude"
                  ? Boolean(selectedMachineRecord?.capabilities.claude)
                  : Boolean(selectedMachineRecord?.capabilities.codex);
                const label = getAgentLabel(summary.reviewerId);
                const hasSummary = Boolean(summary.latestReview?.summary);

                return (
                  <div key={summary.reviewerId} className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex min-w-[140px] flex-1 items-center gap-2">
                        <AgentLogo agent={summary.reviewerId} className="h-4 w-4 shrink-0" />
                        <span className="truncate text-xs font-medium">{label}</span>
                        <Badge variant="outline" className="text-[9px] h-4 px-1">local</Badge>
                      </div>

                      <div className={`inline-flex min-w-[44px] items-center justify-center rounded-full border px-2 py-1 text-xs font-semibold ${scoreAccent(summary.latestReview?.confidenceScore)}`}>
                        {summary.latestReview?.confidenceScore != null ? `${summary.latestReview.confidenceScore}/5` : "--"}
                      </div>

                      <span className="text-[10px] text-muted-foreground">
                        {summary.totalComments} comment{summary.totalComments === 1 ? "" : "s"}
                      </span>
                      {summary.actionableCount > 0 ? (
                        <Badge variant="must_fix" className="text-[10px]">
                          {summary.actionableCount} actionable
                        </Badge>
                      ) : null}
                      <span className="min-w-[52px] text-[10px] text-muted-foreground/60">
                        {summary.latestReview ? formatRelativeTime(summary.latestReview.updatedAt) : ""}
                      </span>

                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {available ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleRequestReview(summary.reviewerId)}
                            disabled={!selectedMachineSlug}
                          >
                            {summary.latestReview ? "Re-review" : "Review"}
                          </Button>
                        ) : null}
                        {hasSummary ? (
                          <Button variant="ghost" size="sm" onClick={() => setSelectedReviewerId(summary.reviewerId)}>
                            Details
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {summary.latestReview?.summary ? (
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {summary.latestReview.summary}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">No review run yet for this reviewer.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        <TimelineCard
          events={(timeline ?? []).map((event) => ({
            _id: event._id,
            eventType: event.eventType,
            detail: event.detail,
            createdAt: event.createdAt,
            debugDetail: event.debugDetail,
          }))}
          suggestion={suggestedTimelineStep}
          onViewDetails={setSelectedTimelineEventId}
        />

        <Card className="overflow-hidden bg-surface">
          <SectionHeader
            title="GitHub Comments"
            detail={`${comments.length} total`}
            pipClassName="bg-primary/70"
          />
          <div className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {comments.length} comment{comments.length === 1 ? "" : "s"}
                </span>
                {pendingGithubCommentCount > 0 ? <Badge variant="default">{pendingGithubCommentCount} pending triage</Badge> : null}
                {fixableGithubCommentCount > 0 ? <Badge variant="must_fix">{fixableGithubCommentCount} actionable</Badge> : null}
                {replyableGithubCommentCount > 0 ? <Badge variant="fixed">{replyableGithubCommentCount} fixed</Badge> : null}
              </div>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5" />
                {selectedMachine ? `Refresh via ${selectedMachine.machineName}` : "Register a machine checkout to refresh"}
              </span>
            </div>
            {refreshError ? (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {refreshError}
              </div>
            ) : null}
            {reviewError ? (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {reviewError}
              </div>
            ) : null}
            {analysisError ? (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {analysisError}
              </div>
            ) : null}
            {fixError ? (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {fixError}
              </div>
            ) : null}
            {replyError ? (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {replyError}
              </div>
            ) : null}

            <div className="mt-3 rounded-lg border border-white/8 bg-black/10 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                  Actions
                </div>
                <span className="text-[11px] text-muted-foreground/70">
                  {selectedMachineRecord
                    ? `Using ${selectedMachineRecord.name}`
                    : "Select a machine checkout to enable comment actions"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {selectedMachineSlug && availableAnalyzerAgents.length > 0 ? (
                    <Select
                      value={preferredActionAgent}
                      onValueChange={(value) => setPreferredActionAgent(value as "claude" | "codex")}
                    >
                      <SelectTrigger className="h-8 w-[240px] bg-transparent text-xs">
                        {preferredActionAgent ? (
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 pr-4">
                            <AgentLogo agent={preferredActionAgent} className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">Preferred agent {getAgentLabel(preferredActionAgent)}</span>
                          </span>
                        ) : (
                          <SelectValue placeholder="Preferred agent" />
                        )}
                      </SelectTrigger>
                    <SelectContent>
                      {availableAnalyzerAgents.map((agent) => (
                        <SelectItem key={`github-action-agent-${agent}`} value={agent}>
                          {getAgentLabel(agent)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {selectedMachineSlug && preferredActionAgent && pendingGithubCommentCount > 0 ? (
                  <Button size="sm" onClick={() => void handleAnalyzeGithubComments(preferredActionAgent)}>
                    <Sparkles className="h-3.5 w-3.5" />
                    Analyze ({pendingGithubCommentCount})
                  </Button>
                ) : null}
                {selectedMachineSlug && preferredActionAgent && githubReanalyzableCount > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleAnalyzeGithubComments(preferredActionAgent, true)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Re-analyze ({githubReanalyzableCount})
                  </Button>
                ) : null}
                {selectedMachineSlug && preferredActionAgent && fixableGithubCommentCount > 0 ? (
                  <Button size="sm" onClick={() => void handleFixGithubComments(preferredActionAgent)}>
                    <Wrench className="h-3.5 w-3.5" />
                    Fix ({fixableGithubCommentCount})
                  </Button>
                ) : null}
                {selectedMachineSlug && selectedMachineRecord?.capabilities.gh && replyableGithubCommentCount > 0 ? (
                  <Button variant="outline" size="sm" onClick={() => void handleReplyToGithubComments()}>
                    <MessageSquareReply className="h-3.5 w-3.5" />
                    Reply ({replyableGithubCommentCount})
                  </Button>
                ) : null}
              </div>
            </div>

            {comments.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-6 text-sm text-muted-foreground">
                No synced GitHub comments for this PR yet.
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {githubFilterTabs.map(({ value, label, count }) => (
                    <Button
                      key={value}
                      variant={githubFilter === value ? "secondary" : "outline"}
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setGithubFilter(value)}
                    >
                      {label} ({count})
                    </Button>
                  ))}
                </div>

                {visibleGithubComments.map((comment) => {
                  const selectedCategory = comment.analysisCategory ?? "UNTRIAGED";
                  return (
                    <Card key={comment._id} className="border-white/8 bg-zinc-900/55 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{comment.user}</Badge>
                            <CommentTypeBadge type={comment.type} />
                            {comment.path ? <Badge variant="outline">{comment.path}{comment.line ? `:${comment.line}` : ""}</Badge> : null}
                            <Badge variant="outline">{comment.status}</Badge>
                            {comment.analysisCategory ? (
                              <Badge variant={categoryVariant[comment.analysisCategory] ?? "outline"}>
                                {categoryLabel[comment.analysisCategory] ?? comment.analysisCategory}
                              </Badge>
                            ) : null}
                            <span className="text-xs text-muted-foreground">{formatTimestamp(comment.updatedAt)}</span>
                          </div>
                        </div>
                        <Select
                          value={selectedCategory}
                          onValueChange={(value) => {
                            if (value === "UNTRIAGED") return;
                            void handleRecategorizeGithubComment(
                              comment._id,
                              value as "MUST_FIX" | "SHOULD_FIX" | "NICE_TO_HAVE" | "DISMISS" | "ALREADY_ADDRESSED",
                            );
                          }}
                        >
                          <SelectTrigger className="h-8 w-[170px] bg-transparent text-xs">
                            <SelectValue placeholder="Set category" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="UNTRIAGED">Pending Triage</SelectItem>
                            <SelectItem value="MUST_FIX">Must Fix</SelectItem>
                            <SelectItem value="SHOULD_FIX">Should Fix</SelectItem>
                            <SelectItem value="NICE_TO_HAVE">Nice to Have</SelectItem>
                            <SelectItem value="ALREADY_ADDRESSED">Already Addressed</SelectItem>
                            <SelectItem value="DISMISS">Dismiss</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="mt-3 text-sm leading-6 text-foreground/88">
                        <MarkdownBody text={comment.body} />
                      </div>
                      <AnalysisDetailsPanel
                        analysisReasoning={comment.analysisReasoning}
                        analysisDetails={comment.analysisDetails}
                      />
                      {comment.fixCommitHash ? (
                        <div className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-sm text-sky-100/90">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">Fix Result</p>
                          <p className="mt-2 text-sm leading-6">
                            Commit <span className="font-mono">{comment.fixCommitHash.slice(0, 12)}</span>
                            {comment.fixFixedAt ? ` · ${formatTimestamp(comment.fixFixedAt)}` : ""}
                          </p>
                          {comment.fixFilesChanged && comment.fixFilesChanged.length > 0 ? (
                            <p className="mt-1 text-xs text-sky-100/80">
                              {comment.fixFilesChanged.length} file{comment.fixFilesChanged.length === 1 ? "" : "s"} changed: {comment.fixFilesChanged.slice(0, 4).join(", ")}
                              {comment.fixFilesChanged.length > 4 ? "..." : ""}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {comment.repliedAt ? (
                        <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-sm text-violet-100/90">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300/80">Reply Posted</p>
                          <p className="mt-2 text-sm leading-6">Replied on {formatTimestamp(comment.repliedAt)}</p>
                          {comment.replyBody ? <p className="mt-1 text-xs text-violet-100/80">{comment.replyBody}</p> : null}
                        </div>
                      ) : null}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden bg-surface">
          <SectionHeader title="Review Comments" detail={reviewComments?.length ?? 0} pipClassName="bg-primary/60" />
          <div className="p-4">
            {publishError ? (
              <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {publishError}
              </div>
            ) : null}
            {selectedMachineRecord ? (
              <div className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                    Actions
                  </div>
                  <span className="text-[11px] text-muted-foreground/70">
                    Using {selectedMachineRecord.name}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {selectedMachineSlug && availableAnalyzerAgents.length > 0 ? (
                    <Select
                      value={preferredActionAgent}
                      onValueChange={(value) => setPreferredActionAgent(value as "claude" | "codex")}
                    >
                      <SelectTrigger className="h-8 w-[240px] bg-transparent text-xs">
                        {preferredActionAgent ? (
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 pr-4">
                            <AgentLogo agent={preferredActionAgent} className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">Preferred agent {getAgentLabel(preferredActionAgent)}</span>
                          </span>
                        ) : (
                          <SelectValue placeholder="Preferred agent" />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        {availableAnalyzerAgents.map((agent) => (
                          <SelectItem key={`review-action-agent-${agent}`} value={agent}>
                            {getAgentLabel(agent)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {selectedMachineSlug && preferredActionAgent && reviewPending.length > 0 ? (
                    <Button size="sm" onClick={() => void handleAnalyzePendingReviewComments(preferredActionAgent)}>
                      <Sparkles className="h-3.5 w-3.5" />
                      Analyze ({reviewPending.length})
                    </Button>
                  ) : null}
                  {selectedMachineSlug && preferredActionAgent && reviewReanalyzableCount > 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleAnalyzePendingReviewComments(preferredActionAgent, true)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Re-analyze ({reviewReanalyzableCount})
                    </Button>
                  ) : null}
                  {selectedMachineSlug && preferredActionAgent && reviewFixableCount > 0 ? (
                    <Button size="sm" onClick={() => void handleFixPendingReviewComments(preferredActionAgent)}>
                      <Wrench className="h-3.5 w-3.5" />
                      Fix ({reviewFixableCount})
                    </Button>
                  ) : null}
                  {selectedMachineSlug && selectedMachineRecord.capabilities.gh && publishableReviewCount > 0 ? (
                    <Button variant="outline" size="sm" onClick={() => void handlePublishAvailableReviews()}>
                      <Upload className="h-3.5 w-3.5" />
                      Publish ({publishableReviewCount})
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {reviewComments && reviewComments.length > 0 ? (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {reviewFilterTabs.map(({ value, label, count }) => (
                    <Button
                      key={value}
                      variant={reviewFilter === value ? "secondary" : "outline"}
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setReviewFilter(value)}
                    >
                      {label} ({count})
                    </Button>
                  ))}
                </div>

                {visibleReviewComments.map((comment) => (
                  <Card key={comment._id} className="border-white/8 bg-black/10 px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="gap-1.5">
                        <AgentInlineLabel agent={comment.reviewerId as "claude" | "codex"} prefix="Reviewed by" />
                      </Badge>
                      <Badge variant="outline">{comment.path}:{comment.line}</Badge>
                      <Badge variant="outline">{comment.status}</Badge>
                      {comment.analysisCategory ? (
                        <Badge variant={categoryVariant[comment.analysisCategory] ?? "outline"}>
                          {categoryLabel[comment.analysisCategory] ?? comment.analysisCategory}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-3 text-sm leading-6 text-foreground/88">
                      <MarkdownBody text={comment.body} />
                    </div>
                    <ReviewerSignalPanel
                      reviewSeverity={comment.reviewSeverity}
                      reviewConfidence={comment.reviewConfidence}
                      reviewEvidence={comment.reviewEvidence}
                    />
                    <AnalysisDetailsPanel
                      analysisReasoning={comment.analysisReasoning}
                      analysisDetails={comment.analysisDetails}
                      suggestion={comment.suggestion}
                    />
                    {comment.fixCommitHash ? (
                      <div className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-sm text-sky-100/90">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">Fix Result</p>
                        <p className="mt-2 text-sm leading-6">
                          Commit <span className="font-mono">{comment.fixCommitHash.slice(0, 12)}</span>
                          {comment.fixFixedAt ? ` · ${formatTimestamp(comment.fixFixedAt)}` : ""}
                        </p>
                        {comment.fixFilesChanged && comment.fixFilesChanged.length > 0 ? (
                          <p className="mt-1 text-xs text-sky-100/80">
                            {comment.fixFilesChanged.length} file{comment.fixFilesChanged.length === 1 ? "" : "s"} changed: {comment.fixFilesChanged.slice(0, 4).join(", ")}
                            {comment.fixFilesChanged.length > 4 ? "..." : ""}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {comment.publishedAt ? (
                      <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-1.5 text-xs text-violet-100/85">
                        <Upload className="h-3.5 w-3.5 shrink-0 text-violet-300/80" />
                        <span className="font-medium text-violet-200/90">Published</span>
                        <span className="truncate text-violet-100/75">Sent to GitHub on {formatTimestamp(comment.publishedAt)}</span>
                      </div>
                    ) : null}
                  </Card>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No review comments stored in Convex yet.</p>
            )}
          </div>
        </Card>
      </div>

      <Dialog
        open={selectedTimelineEvent !== null}
        onClose={() => setSelectedTimelineEventId(null)}
        title={selectedTimelineEvent ? timelineLabel(selectedTimelineEvent.eventType) : "Timeline event"}
        description={selectedTimelineEvent ? formatTimestamp(selectedTimelineEvent.createdAt) : undefined}
        contentClassName="max-w-2xl"
      >
        {selectedTimelineEvent ? (
          (() => {
            const debugDetail =
              selectedTimelineEvent.debugDetail && typeof selectedTimelineEvent.debugDetail === "object"
                ? (selectedTimelineEvent.debugDetail as Record<string, unknown>)
                : null;
            const history = getTimelineRunHistory(debugDetail);
            const prompt = typeof debugDetail?.prompt === "string" ? debugDetail.prompt : null;
            const parameters = debugDetail
              ? Object.fromEntries(
                  Object.entries(debugDetail).filter(([key]) => key !== "prompt" && key !== "history"),
                )
              : null;
            const hasParameters = parameters && Object.keys(parameters).length > 0;
            const detailSummary = formatTimelineDetail(selectedTimelineEvent);
            const selectedTimelineConfig = getTimelineConfig(selectedTimelineEvent.eventType);
            const selectedTimelineTone = getTimelineToneClasses(selectedTimelineConfig.tone);

            return (
              <div className="space-y-4">
                {detailSummary ? (
                  <div className={cn("rounded-lg border px-3 py-3 text-sm text-muted-foreground", selectedTimelineTone.card)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn("h-5 px-2 text-[10px] uppercase tracking-wide", selectedTimelineTone.badge)}>
                        {selectedTimelineConfig.toneLabel}
                      </Badge>
                    </div>
                    <p className="mt-2">{detailSummary}</p>
                  </div>
                ) : null}

                <div className="flex items-center gap-2 border-b border-border pb-3">
                  <Button
                    variant={timelineTab === "history" ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setTimelineTab("history")}
                  >
                    History
                  </Button>
                  <Button
                    variant={timelineTab === "parameters" ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setTimelineTab("parameters")}
                  >
                    Parameters
                  </Button>
                  <Button
                    variant={timelineTab === "prompt" ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setTimelineTab("prompt")}
                    disabled={!prompt}
                  >
                    Prompt
                  </Button>
                </div>

                {!debugDetail ? (
                  <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                    Debug details are not available for this event yet.
                  </div>
                ) : timelineTab === "history" ? (
                  history ? (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{history.status}</Badge>
                        <span className="text-xs text-muted-foreground/80">
                          Started {formatTimestamp(history.startedAt)}
                        </span>
                        <span className="text-xs text-muted-foreground/80">
                          Duration {formatDuration(history.startedAt, history.finishedAt ?? new Date().toISOString())}
                        </span>
                      </div>

                      {history.steps.length > 0 ? (
                        <div className="rounded-lg border border-border bg-surface/80">
                          <div className="border-b border-border px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                            Steps
                          </div>
                          <div className="divide-y divide-border/60">
                            {history.steps.map((step, index) => (
                              <div key={`${step.ts}-${index}`} className="flex items-start gap-2 px-4 py-3">
                                {step.status === "done" ? (
                                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                                ) : step.status === "error" ? (
                                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                                ) : (
                                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm text-foreground/90">{step.step}</span>
                                    <span className="text-[11px] tabular-nums text-muted-foreground/60">
                                      {new Date(step.ts).toLocaleTimeString([], {
                                        hour: "numeric",
                                        minute: "2-digit",
                                        second: "2-digit",
                                      })}
                                    </span>
                                  </div>
                                  {step.detail ? (
                                    <p className="mt-1 text-xs leading-5 text-muted-foreground/80">{step.detail}</p>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                          Run history has not captured any step transitions yet.
                        </div>
                      )}

                      {history.output.length > 0 ? (
                        <div className="rounded-lg border border-border bg-surface/80">
                          <div className="border-b border-border px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                            Output
                          </div>
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-5 text-foreground/78">
                            {history.output.join("\n")}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                      Run history is not available for this event yet.
                    </div>
                  )
                ) : timelineTab === "prompt" ? (
                  prompt ? (
                    <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-4 text-xs leading-6 text-foreground/80 whitespace-pre-wrap break-words">
                      {prompt}
                    </pre>
                  ) : (
                    <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                      No prompt was captured for this event.
                    </div>
                  )
                ) : hasParameters ? (
                  <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-4 text-xs leading-6 text-foreground/80">
                    {JSON.stringify(parameters, null, 2)}
                  </pre>
                ) : (
                  <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                    No structured parameters were captured for this event.
                  </div>
                )}
              </div>
            );
          })()
        ) : null}
      </Dialog>

      <Dialog
        open={selectedReviewerSummary !== null}
        onClose={() => setSelectedReviewerId(null)}
        title={
          selectedReviewerSummary ? (
            <AgentInlineLabel
              agent={selectedReviewerSummary.reviewerId as "claude" | "codex"}
              prefix="Review details"
              className="text-sm"
            />
          ) : (
            "Review details"
          )
        }
        description={
          selectedReviewerSummary?.latestReview?.confidenceScore != null
            ? `Confidence ${selectedReviewerSummary.latestReview.confidenceScore}/5`
            : "No confidence score"
        }
        contentClassName="max-w-2xl"
      >
        {selectedReviewerSummary?.latestReview ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {selectedReviewerSummary.totalComments} comment{selectedReviewerSummary.totalComments === 1 ? "" : "s"}
              </Badge>
              {selectedReviewerSummary.actionableCount > 0 ? (
                <Badge variant="must_fix">{selectedReviewerSummary.actionableCount} actionable</Badge>
              ) : null}
              <span>Updated {formatTimestamp(selectedReviewerSummary.latestReview.updatedAt)}</span>
            </div>
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <Button
                variant={reviewDetailsTab === "summary" ? "secondary" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => setReviewDetailsTab("summary")}
              >
                Summary
              </Button>
              <Button
                variant={reviewDetailsTab === "raw" ? "secondary" : "outline"}
                size="sm"
                className="h-8 text-xs"
                onClick={() => setReviewDetailsTab("raw")}
                disabled={!selectedReviewerSummary.latestReview.rawOutput}
              >
                Raw Output
              </Button>
            </div>
            {reviewDetailsTab === "summary" ? (
              selectedReviewerSummary.latestReview.summary ? (
                <div className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                  <MarkdownBody text={selectedReviewerSummary.latestReview.summary} />
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                  No structured summary was captured for this review.
                </div>
              )
            ) : selectedReviewerSummary.latestReview.rawOutput ? (
              <pre className="overflow-x-auto rounded-lg border border-white/8 bg-black/10 p-3 text-xs leading-6 text-muted-foreground">
                {selectedReviewerSummary.latestReview.rawOutput}
              </pre>
            ) : (
              <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
                No raw output was captured for this review.
              </div>
            )}
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={resetDialogOpen}
        title="Reset PR data?"
        description="This will permanently delete the Convex snapshot for this PR, including GitHub comments, reviews, review comments, timeline history, jobs, and job runs. Use Sync or Refresh PR afterwards to repopulate it."
        confirmLabel={isResetting ? "Resetting..." : "Reset PR data"}
        cancelLabel="Cancel"
        variant="destructive"
        onCancel={() => {
          if (!isResetting) {
            setResetDialogOpen(false);
          }
        }}
        onConfirm={() => void handleResetPrData()}
      />
    </div>
  );
}
