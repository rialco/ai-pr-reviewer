import { usePRComments, useAnalyze, useDismiss, useReopen, useRecategorize, useFixComments, useRevertFix, useReplyToComments, usePRStatus, useRefreshPR, useReviewComments, usePublishReview, useAvailableReviewers, useDismissLocalComment, useDeleteLocalComment, useRecategorizeLocalComment, useAnalyzeLocalReviewComments, useFixLocalComments, useResetLocalComments, useTimeline, useTimelineEvent, useRequestReview, useRefreshReview, useSettings, useSuggestedNextStep, useExecuteSuggestedNextStep, useCoordinatorPRPreference, useUpdateCoordinatorPRPreference, type EnrichedComment, type AnalysisProgressState, type FixProgress, type ReviewCommentData, type TimelineEvent, type AnalyzerAgent, type FixerAgent } from "../hooks/useApi";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { MarkdownBody } from "./MarkdownBody";
import { Card } from "./ui/card";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { SectionHeader } from "./ui/section-header";
import { PROverview } from "./PROverview";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";
import {
  Bot,
  FileCode,
  Sparkles,
  Loader2,
  X,
  Lightbulb,
  ChevronDown,
  ChevronRight,
  Wrench,
  Check,
  AlertCircle,
  RotateCcw,
  RefreshCw,
  History,
  Trash2,
  Undo2,
  MessageSquareReply,
  Send,
  Users,
  Upload,
  Cpu,
  FileText,
  Clock3,
  ArrowRight,
} from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";

interface CommentViewProps {
  repo: string;
  prNumber: number;
}

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

const LOCAL_AGENT_LABEL: Record<AnalyzerAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function localAgentLabel(agent: AnalyzerAgent | undefined): string {
  return agent ? LOCAL_AGENT_LABEL[agent] : "AI";
}

function joinMeta(items: string[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  return items.join(", ");
}

type GuardedActionKind =
  | "analyze_github"
  | "analyze_local"
  | "fix_github"
  | "fix_local"
  | "request_review"
  | "refresh_review"
  | "publish_review"
  | "reply_comments";

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
      kind: "event" | "aggregate";
      title: string;
      description: string | null;
      meta?: string | null;
      icon: typeof Sparkles;
      color: string;
      event: TimelineEvent;
      isLatest: boolean;
    };

const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const RANGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const FIX_PAIR_EVENT_TYPES = new Set([
  "fix_completed",
  "fix_no_changes",
  "fix_failed",
  "local_fix_completed",
  "local_fix_no_changes",
  "local_fix_failed",
]);

const REVIEW_CHANGE_EVENT_TYPES = new Set([
  "fix_completed",
  "local_fix_completed",
  "fix_reverted",
  "comments_replied",
  "review_published",
  "comments_fetched",
]);

function isLocalAnalysisEvent(event: TimelineEvent): boolean {
  return (
    (event.eventType === "analysis_requested" || event.eventType === "comments_analyzed") &&
    event.detail.source === "local_review_comments"
  );
}

function isGitHubAnalysisEvent(event: TimelineEvent): boolean {
  return (
    (event.eventType === "analysis_requested" || event.eventType === "comments_analyzed") &&
    event.detail.source !== "local_review_comments"
  );
}

function sameTimelinePair(newer: TimelineEvent, older: TimelineEvent): boolean {
  if (newer.eventType === "comments_analyzed" && older.eventType === "analysis_requested") {
    return (
      newer.detail.source === older.detail.source &&
      newer.detail.reviewerId === older.detail.reviewerId &&
      newer.detail.analyzerAgent === older.detail.analyzerAgent
    );
  }

  if (
    (newer.eventType === "review_completed" || newer.eventType === "review_failed") &&
    older.eventType === "review_requested"
  ) {
    return newer.detail.reviewerId === older.detail.reviewerId;
  }

  if (FIX_PAIR_EVENT_TYPES.has(newer.eventType)) {
    const expectedStart =
      newer.eventType.startsWith("local_") ? "local_fix_started" : "fix_started";
    return older.eventType === expectedStart && newer.detail.fixerAgent === older.detail.fixerAgent;
  }

  return false;
}

function formatAbsoluteTime(dateStr: string): string {
  return ABSOLUTE_TIME_FORMATTER.format(new Date(dateStr));
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(startDate: string, endDate: string): string {
  const totalSeconds = Math.max(0, Math.floor((new Date(endDate).getTime() - new Date(startDate).getTime()) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatTimelineRange(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const sameDay = start.toDateString() === end.toDateString();

  if (sameDay) {
    return `${formatAbsoluteTime(startDate)} -> ${RANGE_TIME_FORMATTER.format(end)}`;
  }

  return `${formatAbsoluteTime(startDate)} -> ${formatAbsoluteTime(endDate)}`;
}

function LocalAgentSelector({
  value,
  onChange,
  prefix,
  disabled,
  options,
}: {
  value: AnalyzerAgent;
  onChange: (value: AnalyzerAgent) => void;
  prefix: string;
  disabled?: boolean;
  options: Array<{ id: AnalyzerAgent; label: string; available: boolean }>;
}) {
  const selectedOption = options.find((option) => option.id === value);

  return (
    <Select value={value} onValueChange={(next) => onChange(next as AnalyzerAgent)} disabled={disabled}>
      <SelectTrigger className="h-9 w-[176px] max-w-[176px] shrink-0 gap-2 rounded-md border border-border bg-transparent px-2.5 text-xs text-muted-foreground shadow-none focus:ring-0">
        <AgentLogo agent={value} className="h-3.5 w-3.5 shrink-0" />
        <span className="whitespace-nowrap">{prefix}</span>
        <span className="min-w-0 flex-1 truncate text-left text-xs text-foreground/85">
          {selectedOption?.label ?? "Choose agent"}
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id} disabled={!option.available}>
            <span className="flex items-center gap-2">
              <AgentLogo agent={option.id} className="h-3.5 w-3.5 shrink-0" />
              <span>{option.label}{option.available ? "" : " (unavailable)"}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CommentCard({
  comment,
  onDismiss,
  onReopen,
  onRecategorize,
  onRetryFix,
  onReanalyze,
  onFix,
}: {
  comment: EnrichedComment;
  onDismiss: () => void;
  onReopen?: () => void;
  onRecategorize?: (category: string) => void;
  onRetryFix?: () => void;
  onReanalyze?: () => void;
  onFix?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);

  const isLong = comment.body.length > 300;
  const displayBody = expanded || !isLong
    ? comment.body
    : comment.body.slice(0, 300) + "...";

  return (
    <Card className="overflow-hidden">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-muted-foreground truncate">
              {comment.user}
            </span>
            <Badge variant="outline">
              {comment.type === "inline" ? "code" : comment.type === "review" ? "review" : "comment"}
            </Badge>
            {comment.analysis && (
              <Badge variant={categoryVariant[comment.analysis.category] ?? "default"}>
                {categoryLabel[comment.analysis.category] ?? comment.analysis.category}
              </Badge>
            )}
            {comment.status === "fixing" && (
              <Badge variant="fixing">
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Fixing...
              </Badge>
            )}
            {comment.status === "fixed" && (
              <Badge variant="fixed">
                <Check className="h-3 w-3 mr-1" />
                Fixed
              </Badge>
            )}
            {comment.status === "fix_failed" && (
              <Badge variant="fix_failed">
                <AlertCircle className="h-3 w-3 mr-1" />
                Fix Failed
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {comment.status === "fix_failed" && onRetryFix && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onRetryFix} title="Retry the automated fix for this issue">
                <RotateCcw className="h-3 w-3" />
                Retry
              </Button>
            )}
            {comment.analysis && onReanalyze && comment.status !== "fixed" && comment.status !== "fixing" && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onReanalyze} title="Re-run AI analysis on this comment">
                <Sparkles className="h-3 w-3" />
                Analyze
              </Button>
            )}
            {onFix && comment.status !== "fixed" && comment.status !== "fixing" && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onFix} title="Auto-fix this issue in the code">
                <Wrench className="h-3 w-3" />
                Fix
              </Button>
            )}
            {comment.analysis && onRecategorize && comment.status !== "fixed" && comment.status !== "fixing" && (
              <select
                className="h-7 text-[10px] rounded border border-border bg-background text-muted-foreground px-1.5 cursor-pointer hover:border-foreground/30 transition-colors"
                value={comment.analysis.category}
                onChange={(e) => onRecategorize(e.target.value)}
                title="Change the severity category of this comment"
              >
                <option value="MUST_FIX">Must Fix</option>
                <option value="SHOULD_FIX">Should Fix</option>
                <option value="NICE_TO_HAVE">Nice to Have</option>
                <option value="ALREADY_ADDRESSED">Already Addressed</option>
                <option value="DISMISS">Dismiss</option>
              </select>
            )}
            {comment.status === "dismissed" && onReopen && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onReopen} title="Restore this dismissed comment">
                <Undo2 className="h-3 w-3" />
                Reopen
              </Button>
            )}
            {!comment.analysis && comment.status !== "dismissed" && comment.status !== "fixed" && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onDismiss} title="Dismiss this comment as not actionable">
                <X className="h-3 w-3" />
                Dismiss
              </Button>
            )}
          </div>
        </div>

        {/* File location */}
        {comment.path && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
            <FileCode className="h-3.5 w-3.5" />
            <span className="font-mono">
              {comment.path}
              {comment.line ? `:${comment.line}` : ""}
            </span>
          </div>
        )}

        {/* Comment body (rendered as markdown) */}
        <MarkdownBody text={displayBody} />
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-2 text-xs text-primary hover:text-primary/80"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-3 w-3" /> Show less
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" /> Show more
              </>
            )}
          </button>
        )}

        {/* Analysis reasoning (collapsible) */}
        {comment.analysis && (
          <div className="mt-3 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <button
              onClick={() => setAnalysisOpen(!analysisOpen)}
              className="flex items-center gap-1.5 w-full text-left px-3 py-2"
            >
              {analysisOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <span className="font-medium">Analysis</span>
            </button>
            {analysisOpen && (
              <div className="px-3 pb-2 space-y-2">
                <div>{comment.analysis.reasoning}</div>
                {(comment.analysis.confidence != null || comment.analysis.accessMode || comment.analysis.verdict || comment.analysis.evidence) && (
                  <div className="rounded border border-border/60 bg-background/60 p-2 space-y-1.5">
                    <div className="flex flex-wrap gap-1">
                      {comment.analysis.verdict && <Badge variant="outline">{comment.analysis.verdict}</Badge>}
                      {comment.analysis.confidence != null && <Badge variant="outline">Confidence {comment.analysis.confidence}/5</Badge>}
                      {comment.analysis.accessMode && (
                        <Badge variant="outline">
                          {comment.analysis.accessMode === "FULL_CODEBASE" ? "Full Codebase" : "Diff Only"}
                        </Badge>
                      )}
                    </div>
                    {comment.analysis.evidence?.riskSummary && (
                      <div><span className="font-medium text-foreground">Risk:</span> {comment.analysis.evidence.riskSummary}</div>
                    )}
                    {comment.analysis.evidence?.validationNotes && (
                      <div><span className="font-medium text-foreground">Limitations:</span> {comment.analysis.evidence.validationNotes}</div>
                    )}
                    {joinMeta(comment.analysis.evidence?.filesRead) && (
                      <div><span className="font-medium text-foreground">Files:</span> {joinMeta(comment.analysis.evidence?.filesRead)}</div>
                    )}
                    {joinMeta(comment.analysis.evidence?.symbolsChecked) && (
                      <div><span className="font-medium text-foreground">Symbols:</span> {joinMeta(comment.analysis.evidence?.symbolsChecked)}</div>
                    )}
                    {joinMeta(comment.analysis.evidence?.callersChecked) && (
                      <div><span className="font-medium text-foreground">Callers:</span> {joinMeta(comment.analysis.evidence?.callersChecked)}</div>
                    )}
                    {joinMeta(comment.analysis.evidence?.testsChecked) && (
                      <div><span className="font-medium text-foreground">Tests:</span> {joinMeta(comment.analysis.evidence?.testsChecked)}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Reply body */}
        {comment.repliedAt && comment.replyBody && (
          <div className="mt-3 rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 text-green-600 mb-1">
              <MessageSquareReply className="h-3 w-3" />
              <span className="font-medium">Reply</span>
              <span className="text-green-600/60 ml-auto">{new Date(comment.repliedAt).toLocaleString()}</span>
            </div>
            <div className="text-muted-foreground">
              <MarkdownBody text={comment.replyBody} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

type SectionColor = "must_fix" | "should_fix" | "nice_to_have" | "dismiss" | "already_addressed" | "fixing" | "fixed" | "fix_failed" | "muted";

const sectionColorMap: Record<SectionColor, string> = {
  must_fix:          "bg-must-fix",
  should_fix:        "bg-should-fix",
  nice_to_have:      "bg-nice-to-have",
  dismiss:           "bg-dismiss",
  already_addressed: "bg-already-addressed",
  fixing:            "bg-fixing",
  fixed:             "bg-fixed",
  fix_failed:        "bg-fix-failed",
  muted:             "bg-muted-foreground/40",
};

function CollapsibleSection({
  title,
  count,
  badge,
  action,
  color,
  defaultOpen = true,
  opacity,
  embedded,
  children,
}: {
  title: string;
  count: number;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  color?: SectionColor;
  defaultOpen?: boolean;
  opacity?: string;
  embedded?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (count === 0) return null;

  const pip = color ? sectionColorMap[color] : null;

  return (
    <div className={embedded ? "" : "rounded-lg border border-border overflow-hidden"}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className={[
          "flex items-center gap-2.5 px-3 cursor-pointer select-none",
          embedded ? "h-[34px]" : "h-[40px]",
          "transition-colors duration-100",
          "hover:bg-white/[0.04] active:bg-white/[0.06]",
          open ? "bg-white/[0.02]" : "",
        ].join(" ")}
      >
        {/* Color pip */}
        {pip && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pip}`} />}

        <span className={`font-semibold tracking-wide uppercase text-muted-foreground ${embedded ? "text-[10px]" : "text-[11px]"}`}>
          {title}
        </span>
        <span className={`tabular-nums text-muted-foreground/50 ${embedded ? "text-[10px]" : "text-[11px]"}`}>
          {count}
        </span>

        {badge && <span className="ml-0.5">{badge}</span>}

        {/* Chevron */}
        <ChevronRight
          className={[
            "h-3 w-3 ml-auto text-muted-foreground/40 transition-transform duration-200 ease-out",
            open ? "rotate-90" : "",
          ].join(" ")}
        />

        {/* Action buttons — stop click propagation so they don't toggle */}
        {action && (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="ml-1">
            {action}
          </span>
        )}
      </div>

      {/* Animated content with CSS grid trick */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className={`p-2 space-y-2 ${opacity ?? ""}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function LocalReviewCommentCard({
  comment,
  onDismiss,
  onDelete,
  onRecategorize,
  onAnalyze,
  onFix,
}: {
  comment: ReviewCommentData;
  onDismiss: () => void;
  onDelete?: () => void;
  onRecategorize: (category: string) => void;
  onAnalyze?: () => void;
  onFix?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const isLong = comment.body.length > 300;
  const displayBody = expanded || !isLong
    ? comment.body
    : comment.body.slice(0, 300) + "...";

  const canAnalyze = !["fixed", "dismissed", "superseded"].includes(comment.status);
  const canFix = ["analyzed", "fix_failed"].includes(comment.status);
  const canRecategorize = ["analyzed", "fix_failed"].includes(comment.status);
  const canDismiss = !["fixed", "dismissed", "superseded"].includes(comment.status);
  const canDelete = comment.status !== "fixed" && comment.analysisCategory !== "ALREADY_ADDRESSED" && !comment.publishedAt;

  return (
    <Card className="overflow-hidden">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <AgentLogo agent={comment.reviewerId} className="h-4 w-4 shrink-0" />
            <span className="text-xs font-medium text-muted-foreground truncate">
              {getAgentLabel(comment.reviewerId)}
            </span>
            <Badge variant="outline">code</Badge>
            <Badge variant={categoryVariant[comment.analysisCategory] ?? "default"}>
              {categoryLabel[comment.analysisCategory] ?? comment.analysisCategory}
            </Badge>
            {comment.status === "analyzing" && (
              <Badge variant="default">
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Triaging...
              </Badge>
            )}
            {comment.status === "fixing" && (
              <Badge variant="fixing">
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Fixing...
              </Badge>
            )}
            {comment.status === "fixed" && (
              <Badge variant="fixed">
                <Check className="h-3 w-3 mr-1" />
                Fixed
              </Badge>
            )}
            {comment.status === "fix_failed" && (
              <Badge variant="fix_failed">
                <AlertCircle className="h-3 w-3 mr-1" />
                Fix Failed
              </Badge>
            )}
            {comment.publishedAt && (
              <Badge variant="fixed">
                <Check className="h-3 w-3 mr-1" />
                Published
              </Badge>
            )}
            {comment.status === "superseded" && (
              <Badge variant="outline">Superseded</Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onAnalyze && canAnalyze && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onAnalyze} title="Analyze whether this comment is still valid and actionable">
                <Sparkles className="h-3 w-3" />
                Analyze
              </Button>
            )}
            {onFix && canFix && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onFix} title="Auto-fix this issue">
                <Wrench className="h-3 w-3" />
                Fix
              </Button>
            )}
            {canRecategorize && (
              <select
                className="h-7 text-[10px] rounded border border-border bg-background text-muted-foreground px-1.5 cursor-pointer hover:border-foreground/30 transition-colors"
                value={comment.analysisCategory}
                onChange={(e) => onRecategorize(e.target.value)}
                title="Change the severity category"
              >
                <option value="MUST_FIX">Must Fix</option>
                <option value="SHOULD_FIX">Should Fix</option>
                <option value="NICE_TO_HAVE">Nice to Have</option>
                <option value="ALREADY_ADDRESSED">Already Addressed</option>
                <option value="DISMISS">Dismiss</option>
              </select>
            )}
            {canDismiss && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] active:scale-[0.94] transition-transform" onClick={onDismiss} title="Dismiss this comment">
                <X className="h-3 w-3" />
                Dismiss
              </Button>
            )}
            {onDelete && canDelete && (
              <Button variant="ghost" size="sm" className="h-7 px-2 shrink-0 text-[11px] text-destructive active:scale-[0.94] transition-transform" onClick={onDelete} title="Delete this local comment">
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            )}
          </div>
        </div>

        {/* File location */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
          <FileCode className="h-3.5 w-3.5" />
          <span className="font-mono">
            {comment.path}:{comment.line}
          </span>
        </div>

        {/* Comment body */}
        <MarkdownBody text={displayBody} />
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-2 text-xs text-primary hover:text-primary/80"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-3 w-3" /> Show less
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" /> Show more
              </>
            )}
          </button>
        )}

        {comment.reviewDetails && (
          <div className="mt-3 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-xs text-muted-foreground space-y-1.5">
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">Reviewer Signal</Badge>
              {comment.reviewDetails.severity && <Badge variant="outline">{comment.reviewDetails.severity}</Badge>}
              {comment.reviewDetails.confidence != null && (
                <Badge variant="outline">Confidence {comment.reviewDetails.confidence}/5</Badge>
              )}
            </div>
            {comment.reviewDetails.evidence?.riskSummary && (
              <div><span className="font-medium text-foreground">Risk:</span> {comment.reviewDetails.evidence.riskSummary}</div>
            )}
            {joinMeta(comment.reviewDetails.evidence?.filesRead) && (
              <div><span className="font-medium text-foreground">Files:</span> {joinMeta(comment.reviewDetails.evidence?.filesRead)}</div>
            )}
            {joinMeta(comment.reviewDetails.evidence?.changedLinesChecked) && (
              <div><span className="font-medium text-foreground">Changed lines:</span> {joinMeta(comment.reviewDetails.evidence?.changedLinesChecked)}</div>
            )}
            {joinMeta(comment.reviewDetails.evidence?.ruleReferences) && (
              <div><span className="font-medium text-foreground">References:</span> {joinMeta(comment.reviewDetails.evidence?.ruleReferences)}</div>
            )}
          </div>
        )}

        {comment.analysisReasoning && (
          <div className="mt-3 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <button
              onClick={() => setAnalysisOpen(!analysisOpen)}
              className="flex items-center gap-1.5 w-full text-left px-3 py-2"
            >
              {analysisOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <span className="font-medium">Analysis</span>
            </button>
            {analysisOpen && (
              <div className="px-3 pb-2 space-y-2">
                <div>{comment.analysisReasoning}</div>
                {(comment.analysisDetails?.confidence != null || comment.analysisDetails?.accessMode || comment.analysisDetails?.verdict || comment.analysisDetails?.evidence) && (
                  <div className="rounded border border-border/60 bg-background/60 p-2 space-y-1.5">
                    <div className="flex flex-wrap gap-1">
                      {comment.analysisDetails?.verdict && <Badge variant="outline">{comment.analysisDetails.verdict}</Badge>}
                      {comment.analysisDetails?.confidence != null && (
                        <Badge variant="outline">Confidence {comment.analysisDetails.confidence}/5</Badge>
                      )}
                      {comment.analysisDetails?.accessMode && (
                        <Badge variant="outline">
                          {comment.analysisDetails.accessMode === "FULL_CODEBASE" ? "Full Codebase" : "Diff Only"}
                        </Badge>
                      )}
                    </div>
                    {comment.analysisDetails?.evidence?.riskSummary && (
                      <div><span className="font-medium text-foreground">Risk:</span> {comment.analysisDetails.evidence.riskSummary}</div>
                    )}
                    {comment.analysisDetails?.evidence?.validationNotes && (
                      <div><span className="font-medium text-foreground">Limitations:</span> {comment.analysisDetails.evidence.validationNotes}</div>
                    )}
                    {joinMeta(comment.analysisDetails?.evidence?.filesRead) && (
                      <div><span className="font-medium text-foreground">Files:</span> {joinMeta(comment.analysisDetails?.evidence?.filesRead)}</div>
                    )}
                    {joinMeta(comment.analysisDetails?.evidence?.symbolsChecked) && (
                      <div><span className="font-medium text-foreground">Symbols:</span> {joinMeta(comment.analysisDetails?.evidence?.symbolsChecked)}</div>
                    )}
                    {joinMeta(comment.analysisDetails?.evidence?.callersChecked) && (
                      <div><span className="font-medium text-foreground">Callers:</span> {joinMeta(comment.analysisDetails?.evidence?.callersChecked)}</div>
                    )}
                    {joinMeta(comment.analysisDetails?.evidence?.testsChecked) && (
                      <div><span className="font-medium text-foreground">Tests:</span> {joinMeta(comment.analysisDetails?.evidence?.testsChecked)}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Code suggestion */}
        {comment.suggestion && (
          <div className="mt-3 rounded-md border border-emerald-400/20 bg-emerald-400/5 overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70 border-b border-emerald-400/10">
              Suggested change
            </div>
            <pre className="px-3 py-2 text-xs font-mono text-emerald-300/80 overflow-x-auto">{comment.suggestion}</pre>
          </div>
        )}
      </div>
    </Card>
  );
}

function OutputLog({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  if (lines.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="mt-3 max-h-48 overflow-y-auto rounded bg-black/80 p-3 font-mono text-xs text-green-400 space-y-0.5"
    >
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
      ))}
    </div>
  );
}

function AnalysisProgressPanel({ progress }: { progress: AnalysisProgressState }) {
  return (
    <Card className="overflow-hidden border-primary/20 bg-primary/5">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-sm font-medium">Analyzing Comments</span>
        </div>

        {/* Progress steps */}
        <div className="space-y-1.5 mb-3">
          {progress.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              {step.status === "done" ? (
                <Check className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <span className={step.status === "done" ? "text-muted-foreground" : "text-foreground font-medium"}>
                  {step.message}
                </span>
                {step.detail && step.status === "active" && (
                  <p className="text-muted-foreground mt-0.5">{step.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
            style={{ width: `${progress.progress}%` }}
          />
        </div>

        {/* Live analyzer output */}
        <OutputLog lines={progress.output} />

        {progress.error && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            {progress.error}
          </div>
        )}
      </div>
    </Card>
  );
}

function FixProgressPanel({ progress, collapsed: initialCollapsed, embedded }: { progress: FixProgress; collapsed?: boolean; embedded?: boolean }) {
  const hasError = progress.steps.some((s) => s.status === "error");
  const allDone = progress.steps.every((s) => s.status === "done");
  const [collapsed, setCollapsed] = useState(initialCollapsed ?? false);
  const agentLabel = localAgentLabel(progress.agent);

  const statusPip = hasError ? "bg-fix-failed" : allDone ? "bg-fixed" : "bg-fixing";

  return (
    <div className={embedded ? "" : "rounded-lg border border-border overflow-hidden"}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(!collapsed); } }}
        className={[
          "flex items-center gap-2.5 px-3 h-[40px] cursor-pointer select-none",
          "transition-colors duration-100",
          "hover:bg-white/[0.04] active:bg-white/[0.06]",
          !collapsed ? "bg-white/[0.02]" : "",
        ].join(" ")}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusPip}`} />

        {!allDone && !hasError && (
          <Loader2 className="h-3 w-3 animate-spin text-fixing shrink-0" />
        )}

        <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground">
          {hasError ? "Fix Failed" : allDone ? "Fix Complete" : "Fixing Issues"}
        </span>
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[9px]">
          <AgentLogo agent={progress.agent} className="h-3 w-3 shrink-0" />
          {agentLabel}
        </Badge>

        <span className="text-[10px] text-muted-foreground/50 ml-auto">
          {new Date(progress.startedAt).toLocaleTimeString()}
          {progress.finishedAt && ` — ${new Date(progress.finishedAt).toLocaleTimeString()}`}
        </span>

        <ChevronRight
          className={[
            "h-3 w-3 text-muted-foreground/40 transition-transform duration-200 ease-out",
            !collapsed ? "rotate-90" : "",
          ].join(" ")}
        />
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-3 py-2 space-y-1.5">
            {progress.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {step.status === "done" ? (
                  <Check className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                ) : step.status === "error" ? (
                  <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <span className={
                    step.status === "done" ? "text-muted-foreground" :
                    step.status === "error" ? "text-destructive font-medium" :
                    "text-foreground font-medium"
                  }>
                    {step.step}
                  </span>
                  {step.detail && (
                    <p className={`mt-0.5 ${step.status === "error" ? "text-destructive/80" : "text-muted-foreground"}`}>
                      {step.detail}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {/* Live fixer output */}
            <OutputLog lines={progress.output} />
          </div>
        </div>
      </div>
    </div>
  );
}

function FixedCommitGroup({ hash, comments, onRevert, revertPending }: {
  hash: string;
  comments: EnrichedComment[];
  onRevert: () => void;
  revertPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const allReplied = comments.every((c) => c.repliedAt || c.type !== "inline");

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className={[
          "flex items-center gap-2.5 px-3 h-[40px] cursor-pointer select-none",
          "transition-colors duration-100",
          "hover:bg-white/[0.04] active:bg-white/[0.06]",
          open ? "bg-white/[0.02]" : "",
        ].join(" ")}
      >
        <span className="text-[10px] font-mono text-muted-foreground">
          {hash}
        </span>
        <span className="text-[10px] text-muted-foreground">
          — {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
        {allReplied && (
          <Badge variant="fixed" className="text-[9px] h-4 px-1">
            <Check className="h-2.5 w-2.5 mr-0.5" />
            replied
          </Badge>
        )}

        <ChevronRight
          className={[
            "h-3 w-3 ml-auto text-muted-foreground/40 transition-transform duration-200 ease-out",
            open ? "rotate-90" : "",
          ].join(" ")}
        />

        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Button
            variant="outline"
            size="sm"
            className="h-5 text-[10px] px-2"
            onClick={onRevert}
            disabled={revertPending}
          >
            <Undo2 className="h-2.5 w-2.5" />
            Revert
          </Button>
        </span>
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="p-2 space-y-2">
            {comments.map((c) => (
              <CommentCard key={c.id} comment={c} onDismiss={() => {}} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Timeline ---

const timelineEventConfig: Record<string, { icon: typeof Sparkles; label: string; color: string }> = {
  comments_fetched: { icon: RefreshCw, label: "Comments synced", color: "text-blue-400" },
  analysis_requested: { icon: Sparkles, label: "Analysis requested", color: "text-violet-400" },
  comments_analyzed: { icon: Sparkles, label: "Comments analyzed", color: "text-violet-400" },
  fix_started: { icon: Wrench, label: "Fix started", color: "text-yellow-400" },
  fix_completed: { icon: Check, label: "Fix committed", color: "text-emerald-400" },
  fix_no_changes: { icon: AlertCircle, label: "Fix — no changes", color: "text-muted-foreground" },
  fix_failed: { icon: X, label: "Fix failed", color: "text-destructive" },
  local_fix_started: { icon: Wrench, label: "Local fix started", color: "text-yellow-400" },
  local_fix_completed: { icon: Check, label: "Local fix committed", color: "text-emerald-400" },
  local_fix_no_changes: { icon: AlertCircle, label: "Local fix — no changes", color: "text-muted-foreground" },
  local_fix_failed: { icon: X, label: "Local fix failed", color: "text-destructive" },
  review_requested: { icon: Cpu, label: "Review requested", color: "text-blue-400" },
  review_completed: { icon: Users, label: "Review completed", color: "text-emerald-400" },
  review_failed: { icon: X, label: "Review failed", color: "text-destructive" },
  score_refreshed: { icon: RefreshCw, label: "Score refreshed", color: "text-blue-400" },
  comments_replied: { icon: MessageSquareReply, label: "Replied on GitHub", color: "text-emerald-400" },
  fix_reverted: { icon: Undo2, label: "Fix reverted", color: "text-orange-400" },
  review_published: { icon: Upload, label: "Review published", color: "text-emerald-400" },
};

function getTimelineConfig(event: TimelineEvent): { icon: typeof Sparkles; label: string; color: string } {
  const base = timelineEventConfig[event.eventType] ?? {
    icon: History,
    label: event.eventType,
    color: "text-muted-foreground",
  };

  if (event.eventType === "analysis_requested" || event.eventType === "comments_analyzed") {
    if (event.detail.source === "local_review_comments") {
      return {
        ...base,
        label: event.eventType === "analysis_requested" ? "Local triage started" : "Local comments triaged",
      };
    }
  }

  return base;
}

function formatTimelineDetail(event: TimelineEvent): string | null {
  const d = event.detail;
  switch (event.eventType) {
    case "comments_fetched":
      return `${d.newCount} new comment${(d.newCount as number) !== 1 ? "s" : ""}`;
    case "analysis_requested":
      return `${String(d.analyzerName ?? localAgentLabel(d.analyzerAgent as AnalyzerAgent | undefined))} • ${d.commentCount} comment(s) queued`;
    case "comments_analyzed": {
      const cats = d.categories as Record<string, number> | undefined;
      const prefix = String(d.analyzerName ?? localAgentLabel(d.analyzerAgent as AnalyzerAgent | undefined));
      if (!cats) return `${prefix} • ${d.count} comment(s)`;
      const parts = Object.entries(cats).map(([k, v]) => `${v} ${k.replace("_", " ").toLowerCase()}`);
      return `${prefix} • ${parts.join(", ")}`;
    }
    case "fix_started":
    case "local_fix_started":
      return `${d.commentCount} comment(s) with ${localAgentLabel(d.fixerAgent as FixerAgent | undefined)}`;
    case "fix_completed":
    case "local_fix_completed":
      return `${localAgentLabel(d.fixerAgent as FixerAgent | undefined)} • ${d.commitHash} • ${(d.filesChanged as string[])?.length ?? 0} file(s) • cycle #${d.cycle}`;
    case "fix_no_changes":
    case "local_fix_no_changes":
      return `${localAgentLabel(d.fixerAgent as FixerAgent | undefined)} ran but produced no diff`;
    case "fix_failed":
    case "local_fix_failed":
      return `${localAgentLabel(d.fixerAgent as FixerAgent | undefined)}: ${String(d.error ?? "").slice(0, 120)}`;
    case "review_requested":
      return String(d.reviewerName ?? d.reviewerId ?? "");
    case "review_completed": {
      const score = d.confidenceScore != null ? `${d.confidenceScore}/5` : "no score";
      const comments = d.commentCount ? `, ${d.commentCount} comment(s)` : "";
      return `${d.reviewerName ?? d.reviewerId} — ${score}${comments}`;
    }
    case "review_failed":
      return `${d.reviewerName ?? d.reviewerId}: ${String(d.error ?? "").slice(0, 100)}`;
    case "score_refreshed":
      return `${d.reviewerId}: ${d.confidenceScore != null ? `${d.confidenceScore}/5` : "no score"}`;
    case "comments_replied":
      return `${d.count} comment(s)`;
    case "fix_reverted":
      return `Commit ${d.commitHash}${d.gitReverted ? "" : " (DB only, git revert failed)"}`;
    case "review_published":
      return `${d.reviewerId} — ${d.commentCount} comment(s)`;
    default:
      return null;
  }
}

function findTimelineActionEvent(
  events: TimelineEvent[],
  kind: GuardedActionKind,
  context?: { reviewerId?: string },
): TimelineEvent | null {
  for (const event of events) {
    if (kind === "analyze_github") {
      if (isGitHubAnalysisEvent(event)) return event;
      if (event.eventType === "comments_fetched" || event.eventType === "fix_completed" || event.eventType === "local_fix_completed" || event.eventType === "fix_reverted") {
        return null;
      }
      continue;
    }

    if (kind === "analyze_local") {
      if (
        isLocalAnalysisEvent(event) &&
        (context?.reviewerId == null || event.detail.reviewerId === context.reviewerId)
      ) {
        return event;
      }
      if (
        ((event.eventType === "review_completed" || event.eventType === "review_requested") &&
          (context?.reviewerId == null || event.detail.reviewerId === context.reviewerId)) ||
        event.eventType === "local_fix_completed" ||
        event.eventType === "fix_completed" ||
        event.eventType === "fix_reverted"
      ) {
        return null;
      }
      continue;
    }

    if (kind === "fix_github") {
      if (event.eventType === "fix_completed" || event.eventType === "fix_no_changes") return event;
      if (isGitHubAnalysisEvent(event) || event.eventType === "comments_fetched" || event.eventType === "fix_reverted") {
        return null;
      }
      continue;
    }

    if (kind === "fix_local") {
      if (event.eventType === "local_fix_completed" || event.eventType === "local_fix_no_changes") return event;
      if (
        isLocalAnalysisEvent(event) ||
        event.eventType === "review_completed" ||
        event.eventType === "fix_reverted"
      ) {
        return null;
      }
      continue;
    }

    if (kind === "request_review" || kind === "refresh_review") {
      if (
        (event.eventType === "review_requested" ||
          event.eventType === "review_completed" ||
          event.eventType === "score_refreshed") &&
        (context?.reviewerId == null || event.detail.reviewerId === context.reviewerId)
      ) {
        return event;
      }
      if (REVIEW_CHANGE_EVENT_TYPES.has(event.eventType)) return null;
      continue;
    }

    if (kind === "publish_review") {
      if (
        event.eventType === "review_published" &&
        (context?.reviewerId == null || event.detail.reviewerId === context.reviewerId)
      ) {
        return event;
      }
      if (
        (isLocalAnalysisEvent(event) &&
          (context?.reviewerId == null || event.detail.reviewerId === context.reviewerId)) ||
        ((event.eventType === "review_completed" || event.eventType === "local_fix_completed") &&
          (context?.reviewerId == null || event.detail.reviewerId == null || event.detail.reviewerId === context.reviewerId)) ||
        event.eventType === "fix_reverted"
      ) {
        return null;
      }
      continue;
    }

    if (kind === "reply_comments") {
      if (event.eventType === "comments_replied") return event;
      if (event.eventType === "fix_completed" || event.eventType === "comments_fetched" || event.eventType === "fix_reverted") {
        return null;
      }
    }
  }

  return null;
}

function guardReason(kind: GuardedActionKind): string {
  switch (kind) {
    case "analyze_github":
      return "there haven't been newer synced comments or recorded code changes since";
    case "analyze_local":
      return "there haven't been newer local review comments or recorded code changes since";
    case "fix_github":
      return "there hasn't been a newer GitHub comment analysis pass since";
    case "fix_local":
      return "there hasn't been a newer local triage pass since";
    case "request_review":
    case "refresh_review":
      return "there hasn't been a recorded fix, publish, reply, or comment sync since";
    case "publish_review":
      return "there haven't been newer triaged local comments since";
    case "reply_comments":
      return "there haven't been newer fixed comments or synced replies since";
    default:
      return "there hasn't been a meaningful change since";
  }
}

function buildTimelineItems(
  events: TimelineEvent[],
  suggestion: TimelineDisplayItem | null,
): TimelineDisplayItem[] {
  const items: TimelineDisplayItem[] = suggestion ? [suggestion] : [];
  let latestAssigned = false;

  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    const next = events[index + 1];
    const config = getTimelineConfig(current);

    if (next && sameTimelinePair(current, next)) {
      const latest = !latestAssigned;
      latestAssigned = true;
      items.push({
        key: `aggregate-${current.id}-${next.id}`,
        kind: "aggregate",
        title: config.label,
        description: formatTimelineDetail(current),
        meta: `${formatTimelineRange(next.createdAt, current.createdAt)} • ${formatDuration(next.createdAt, current.createdAt)}`,
        icon: config.icon,
        color: config.color,
        event: next.hasDebug ? next : current,
        isLatest: latest,
      });
      index += 1;
      continue;
    }

    const latest = !latestAssigned;
    latestAssigned = true;
    items.push({
      key: `event-${current.id}`,
      kind: "event",
      title: config.label,
      description: formatTimelineDetail(current),
      meta: formatAbsoluteTime(current.createdAt),
      icon: config.icon,
      color: config.color,
      event: current,
      isLatest: latest,
    });
  }

  return items;
}

function TimelineEventDetailsDialog({
  repo,
  prNumber,
  event,
  onClose,
}: {
  repo: string;
  prNumber: number;
  event: TimelineEvent | null;
  onClose: () => void;
}) {
  const open = event !== null;
  const { data, isLoading, error } = useTimelineEvent(repo, prNumber, event?.id ?? null, open);
  const [activeTab, setActiveTab] = useState<"parameters" | "prompt">("parameters");

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    setActiveTab("parameters");
  }, [event?.id]);

  if (!open || !event) return null;

  const resolvedEvent = data ?? event;
  const config = getTimelineConfig(resolvedEvent);
  const Icon = config.icon;
  const detail = formatTimelineDetail(resolvedEvent);
  const debugDetail = data?.debugDetail ?? null;
  const prompt = typeof debugDetail?.prompt === "string" ? debugDetail.prompt : null;
  const parameters = debugDetail
    ? Object.fromEntries(Object.entries(debugDetail).filter(([key]) => key !== "prompt"))
    : null;
  const hasParameters = parameters && Object.keys(parameters).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/55" onClick={onClose} />
      <div className="relative z-50 flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className={`mt-0.5 rounded-md border border-border/60 bg-surface p-2 ${config.color}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground/90">{config.label}</h3>
              <span className="text-[11px] text-muted-foreground/60">
                {new Date(resolvedEvent.createdAt).toLocaleString()}
              </span>
            </div>
            {detail && (
              <p className="mt-1 text-sm text-muted-foreground/80">{detail}</p>
            )}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <Button
            variant={activeTab === "parameters" ? "secondary" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setActiveTab("parameters")}
          >
            Parameters
          </Button>
          <Button
            variant={activeTab === "prompt" ? "secondary" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setActiveTab("prompt")}
            disabled={!prompt}
          >
            Prompt
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {isLoading && !data ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading event details...
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Failed to load event details: {String(error)}
            </div>
          ) : !debugDetail ? (
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
              Debug details are not available for this event yet.
            </div>
          ) : activeTab === "prompt" ? (
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
      </div>
    </div>
  );
}

function PRTimeline({
  events,
  suggestion,
  onViewDetails,
}: {
  events: TimelineEvent[];
  suggestion: TimelineDisplayItem | null;
  onViewDetails: (event: TimelineEvent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => buildTimelineItems(events, suggestion), [events, suggestion]);
  const visible = expanded ? items : items.slice(0, 6);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <SectionHeader
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }}
        title="Timeline"
        detail={(
          <span className="ml-auto flex items-center gap-2">
            <History className="h-3.5 w-3.5 text-muted-foreground/60" />
            {events.length} event{events.length !== 1 ? "s" : ""}
            <ChevronDown
              className={[
                "h-3 w-3 text-muted-foreground/40 transition-transform duration-200 ease-out",
                expanded ? "rotate-180" : "",
              ].join(" ")}
            />
          </span>
        )}
        pipClassName="bg-primary/70"
        interactive
      />
      <div>
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
                          <span className={cn("text-[10px] font-semibold uppercase tracking-[0.16em]", toneAccent)}>
                            Suggested next step
                          </span>
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
            const hasPreviousConnection =
              previousItem?.kind === "event" || previousItem?.kind === "aggregate";
            const hasNextConnection =
              nextItem?.kind === "event" || nextItem?.kind === "aggregate";

            return (
              <div
                key={item.key}
                className={cn(
                  "flex gap-3 px-3 py-3 transition-opacity duration-200",
                  item.isLatest ? "opacity-100" : "opacity-45 hover:opacity-80",
                )}
              >
                <div className="relative flex w-8 shrink-0 justify-center">
                  {hasPreviousConnection && (
                    <span className="absolute left-1/2 top-[-12px] h-[16px] w-px -translate-x-1/2 bg-foreground/20" />
                  )}
                  {hasNextConnection && (
                    <span className="absolute left-1/2 top-8 bottom-[-12px] w-px -translate-x-1/2 bg-foreground/20" />
                  )}
                  <div
                    className={cn(
                      "relative z-10 mt-0.5 flex h-7 w-7 items-center justify-center rounded-full border bg-background/90",
                      item.isLatest ? "border-current/20 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]" : "border-border/80",
                      item.color,
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-foreground/92">{item.title}</span>
                    {item.isLatest && (
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase tracking-wide">
                        Latest
                      </Badge>
                    )}
                    <span
                      className="text-[10px] tabular-nums text-muted-foreground/55"
                      title={new Date(item.event.createdAt).toLocaleString()}
                    >
                      {formatRelativeTime(item.event.createdAt)}
                    </span>
                  </div>
                  {item.meta && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/62">
                      <Clock3 className="h-3 w-3 shrink-0" />
                      <span>{item.meta}</span>
                    </p>
                  )}
                  {item.description && (
                    <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground/75">{item.description}</p>
                  )}
                </div>
                {item.event.hasDebug && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 gap-1.5 px-2 text-[10px]"
                    onClick={() => onViewDetails(item.event)}
                  >
                    <FileText className="h-3 w-3" />
                    View details
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {items.length > 6 && !expanded && (
          <div className="px-3 py-1 border-t border-border/50">
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
              className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              Show {items.length - 6} more...
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentView({ repo, prNumber }: CommentViewProps) {
  const { data: comments, isLoading, refetch } = usePRComments(repo, prNumber);
  const analyze = useAnalyze();
  const analyzeLocal = useAnalyzeLocalReviewComments();
  const dismiss = useDismiss();
  const reopen = useReopen();
  const recategorize = useRecategorize();
  const fixMutation = useFixComments();
  const revertFix = useRevertFix();
  const replyToComments = useReplyToComments();
  const refreshPR = useRefreshPR();
  const { data: prStatus } = usePRStatus(repo, prNumber);
  const { data: localComments } = useReviewComments(repo, prNumber);
  const { data: reviewers } = useAvailableReviewers();
  const requestReview = useRequestReview();
  const refreshReview = useRefreshReview();
  const { data: settings } = useSettings();
  const publishReview = usePublishReview();
  const dismissLocal = useDismissLocalComment();
  const deleteLocal = useDeleteLocalComment();
  const recategorizeLocal = useRecategorizeLocalComment();
  const fixLocal = useFixLocalComments();
  const resetLocal = useResetLocalComments();
  const { data: timeline } = useTimeline(repo, prNumber);
  const { data: coordinatorPreference } = useCoordinatorPRPreference(repo, prNumber);
  const updateCoordinatorPreference = useUpdateCoordinatorPRPreference();
  const defaultAnalyzerAgent = settings?.defaultAnalyzerAgent ?? "claude";
  const defaultFixerAgent = settings?.defaultFixerAgent ?? "claude";
  const { data: nextStep } = useSuggestedNextStep(repo, prNumber);
  const executeNextStep = useExecuteSuggestedNextStep();
  const [selectedTimelineEvent, setSelectedTimelineEvent] = useState<TimelineEvent | null>(null);
  const [revertHash, setRevertHash] = useState<string | null>(null);
  const [guardDialog, setGuardDialog] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const [showReplyPreview, setShowReplyPreview] = useState(false);
  const [selectedAnalyzerAgent, setSelectedAnalyzerAgent] = useState<AnalyzerAgent>("claude");
  const [selectedFixerAgent, setSelectedFixerAgent] = useState<FixerAgent>("claude");
  const [hasAnalyzerOverride, setHasAnalyzerOverride] = useState(false);
  const [hasFixerOverride, setHasFixerOverride] = useState(false);

  const localCommentsByReviewer = useMemo(() => {
    const map = new Map<string, ReviewCommentData[]>();
    for (const c of localComments ?? []) {
      const arr = map.get(c.reviewerId) ?? [];
      arr.push(c);
      map.set(c.reviewerId, arr);
    }
    return map;
  }, [localComments]);

  const localAgentOptions = useMemo(() => {
    return (["claude", "codex"] as AnalyzerAgent[]).map((agent) => {
      const reviewer = reviewers?.find((r) => r.id === agent);
      return {
        id: agent,
        label: reviewer?.displayName ?? LOCAL_AGENT_LABEL[agent],
        available: reviewer?.available ?? true,
      };
    });
  }, [reviewers]);

  const analyzerAgentOptions = localAgentOptions;
  const fixerAgentOptions = localAgentOptions;

  const availableAnalyzerAgents = useMemo(
    () => analyzerAgentOptions.filter((option) => option.available),
    [analyzerAgentOptions],
  );
  const availableFixerAgents = useMemo(
    () => fixerAgentOptions.filter((option) => option.available),
    [fixerAgentOptions],
  );
  const hasAvailableAnalyzer = availableAnalyzerAgents.length > 0;
  const hasAvailableFixer = availableFixerAgents.length > 0;
  const selectedAnalyzerLabel =
    analyzerAgentOptions.find((option) => option.id === selectedAnalyzerAgent)?.label ??
    localAgentLabel(selectedAnalyzerAgent);
  const selectedFixerLabel =
    fixerAgentOptions.find((option) => option.id === selectedFixerAgent)?.label ??
    localAgentLabel(selectedFixerAgent);

  useEffect(() => {
    if (!hasAvailableAnalyzer) return;
    if (!availableAnalyzerAgents.some((option) => option.id === selectedAnalyzerAgent)) {
      setSelectedAnalyzerAgent(availableAnalyzerAgents[0].id);
    }
  }, [availableAnalyzerAgents, hasAvailableAnalyzer, selectedAnalyzerAgent]);

  useEffect(() => {
    if (!hasAvailableFixer) return;
    if (!availableFixerAgents.some((option) => option.id === selectedFixerAgent)) {
      setSelectedFixerAgent(availableFixerAgents[0].id);
    }
  }, [availableFixerAgents, hasAvailableFixer, selectedFixerAgent]);

  useEffect(() => {
    if (hasAnalyzerOverride) return;
    setSelectedAnalyzerAgent(defaultAnalyzerAgent);
  }, [defaultAnalyzerAgent, hasAnalyzerOverride]);

  useEffect(() => {
    if (hasFixerOverride) return;
    setSelectedFixerAgent(defaultFixerAgent);
  }, [defaultFixerAgent, hasFixerOverride]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading comments...
      </div>
    );
  }

  if (!comments?.length && !(localComments?.length)) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Bot className="h-8 w-8 mb-3 opacity-40" />
        <p className="text-sm">No comments on this PR yet</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => refreshPR.mutate({ repo, prNumber }, { onSuccess: () => refetch() })}
          disabled={refreshPR.isPending}
        >
          {refreshPR.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Fetch from GitHub
        </Button>
      </div>
    );
  }

  const githubComments = comments ?? [];

  // Group by status
  const unanalyzed = githubComments.filter(
    (c) => c.status === "new" || (!c.analysis && c.status !== "dismissed"),
  );
  const fixingComments = githubComments.filter((c) => c.status === "fixing");
  const fixFailedComments = githubComments.filter((c) => c.status === "fix_failed");
  const fixedComments = githubComments.filter((c) => c.status === "fixed");
  const dismissed = githubComments.filter((c) => c.status === "dismissed");

  // Group analyzed comments by category
  const analyzedNotActioned = githubComments.filter(
    (c) =>
      c.analysis &&
      !["fixed", "fixing", "fix_failed", "dismissed"].includes(c.status),
  );

  const mustFix = analyzedNotActioned.filter((c) => c.analysis?.category === "MUST_FIX");
  const shouldFix = analyzedNotActioned.filter((c) => c.analysis?.category === "SHOULD_FIX");
  const niceToHave = analyzedNotActioned.filter((c) => c.analysis?.category === "NICE_TO_HAVE");
  const dismissedByAnalysis = analyzedNotActioned.filter((c) => c.analysis?.category === "DISMISS");
  const alreadyAddressed = analyzedNotActioned.filter((c) => c.analysis?.category === "ALREADY_ADDRESSED");
  const githubBlockingFixFailed = fixFailedComments.filter((c) => c.analysis?.category !== "SHOULD_FIX");
  const isMergeReady = (nextStep?.action === "merge_ready") || prStatus?.phase === "merge_ready";

  const fixableCount =
    isMergeReady
      ? mustFix.length + githubBlockingFixFailed.length
      : (prStatus?.fixableCount ?? mustFix.length + shouldFix.length + fixFailedComments.length);
  const isFixing = fixMutation.isPending || prStatus?.phase === "fixing";
  const allLocal = localComments ?? [];
  const localPending = allLocal.filter((c) => c.status === "new" || c.status === "analyzing");
  const localFixing = allLocal.filter((c) => c.status === "fixing");
  const localFixFailed = allLocal.filter((c) => c.status === "fix_failed");
  const localFixed = allLocal.filter((c) => c.status === "fixed");
  const localSuperseded = allLocal.filter((c) => c.status === "superseded");
  const localDismissed = allLocal.filter((c) => c.status === "dismissed");
  const localAnalyzed = allLocal.filter((c) => c.status === "analyzed" && !c.supersededAt);
  const localMustFix = localAnalyzed.filter((c) => c.analysisCategory === "MUST_FIX");
  const localShouldFix = localAnalyzed.filter((c) => c.analysisCategory === "SHOULD_FIX");
  const localNiceToHave = localAnalyzed.filter((c) => c.analysisCategory === "NICE_TO_HAVE");
  const localAlreadyAddressed = localAnalyzed.filter((c) => c.analysisCategory === "ALREADY_ADDRESSED");
  const localDismissedByAnalysis = localAnalyzed.filter((c) => c.analysisCategory === "DISMISS");
  const localBlockingFixFailed = localFixFailed.filter((c) => c.analysisCategory !== "SHOULD_FIX");
  const localFixableCount = isMergeReady
    ? localMustFix.length + localBlockingFixFailed.length
    : localMustFix.length + localShouldFix.length + localFixFailed.length;
  const publishable = allLocal.filter((c) =>
    !c.publishedAt &&
    c.status === "analyzed" &&
    !c.supersededAt &&
    !["DISMISS", "ALREADY_ADDRESSED"].includes(c.analysisCategory),
  );
  const isLocalFixing = fixLocal.isPending || localFixing.length > 0;
  const isLocalAnalyzing = analyzeLocal.isPending || localPending.some((c) => c.status === "analyzing");
  const inlineFixed = fixedComments.filter((c) => c.type === "inline");
  const timelineEvents = timeline ?? [];

  function runGuardedAction(
    kind: GuardedActionKind,
    options: {
      run: () => void;
      confirmLabel: string;
      reviewerId?: string;
      actionLabel: string;
    },
  ) {
    const blockingEvent = findTimelineActionEvent(timelineEvents, kind, {
      reviewerId: options.reviewerId,
    });

    if (!blockingEvent) {
      options.run();
      return;
    }

    const eventLabel = getTimelineConfig(blockingEvent).label;
    setGuardDialog({
      title: `Repeat ${options.actionLabel}?`,
      description: `The latest matching event on this PR was "${eventLabel}" ${formatRelativeTime(blockingEvent.createdAt)}, and ${guardReason(kind)}. Continue anyway?`,
      confirmLabel: options.confirmLabel,
      onConfirm: options.run,
    });
  }

  const runAnalyzeGitHub = () =>
    runGuardedAction("analyze_github", {
      actionLabel: "analysis",
      confirmLabel: "Analyze again",
      run: () => analyze.mutate({ repo, prNumber, analyzerAgent: selectedAnalyzerAgent }),
    });

  const runReanalyzeGitHub = () =>
    runGuardedAction("analyze_github", {
      actionLabel: "analysis",
      confirmLabel: "Re-analyze",
      run: () =>
        analyze.mutate({
          repo,
          prNumber,
          commentIds: analyzedNotActioned.map((comment) => comment.id),
          analyzerAgent: selectedAnalyzerAgent,
        }),
    });

  const runFixGitHub = (commentIds?: number[]) =>
    runGuardedAction("fix_github", {
      actionLabel: "fix",
      confirmLabel: "Fix anyway",
      run: () => fixMutation.mutate({ repo, prNumber, commentIds, fixerAgent: selectedFixerAgent }),
    });

  const runAnalyzeLocal = (reviewerId?: string, commentIds?: number[]) =>
    runGuardedAction("analyze_local", {
      actionLabel: "local triage",
      confirmLabel: "Analyze anyway",
      reviewerId,
      run: () => analyzeLocal.mutate({ repo, prNumber, reviewerId, commentIds }),
    });

  const runFixLocalAction = (commentIds?: number[]) =>
    runGuardedAction("fix_local", {
      actionLabel: "local fix",
      confirmLabel: "Fix anyway",
      run: () => fixLocal.mutate({ repo, prNumber, commentIds, fixerAgent: selectedFixerAgent }),
    });

  const runRequestReviewAction = (reviewerId: string) =>
    runGuardedAction("request_review", {
      actionLabel: "review request",
      confirmLabel: "Request review",
      reviewerId,
      run: () => requestReview.mutate({ repo, prNumber, reviewerId }),
    });

  const runRefreshReviewAction = (reviewerId: string) =>
    runGuardedAction("refresh_review", {
      actionLabel: "score refresh",
      confirmLabel: "Refresh anyway",
      reviewerId,
      run: () => refreshReview.mutate({ repo, prNumber, reviewerId }),
    });

  const runPublishAll = () =>
    runGuardedAction("publish_review", {
      actionLabel: "publish",
      confirmLabel: "Publish anyway",
      run: () => {
        for (const [reviewerId, commentsForReviewer] of localCommentsByReviewer) {
          const hasPublishable = commentsForReviewer.some((comment) =>
            !comment.publishedAt &&
            comment.status === "analyzed" &&
            !comment.supersededAt &&
            !["DISMISS", "ALREADY_ADDRESSED"].includes(comment.analysisCategory),
          );
          if (!hasPublishable) continue;
          publishReview.mutate({ repo, prNumber, reviewerId });
        }
      },
    });

  const suggestedStep: TimelineDisplayItem | null = nextStep
    ? {
        key: `suggest-${nextStep.action}`,
        kind: "suggested",
        title: nextStep.title,
        description: nextStep.description,
        icon:
          nextStep.action === "fix_github" || nextStep.action === "fix_local"
            ? Wrench
            : nextStep.action === "publish_review"
              ? Upload
              : nextStep.action === "reply_comments"
                ? MessageSquareReply
                : nextStep.action === "request_review"
                  ? Cpu
                  : nextStep.action === "merge_ready"
                    ? Check
                  : nextStep.action === "ignored"
                    ? Clock3
                    : nextStep.action === "idle"
                    ? Lightbulb
                    : Sparkles,
        buttonLabel:
          nextStep.canExecute
            ? executeNextStep.isPending
              ? "Running..."
              : nextStep.action === "request_review"
                ? "Request review"
                : nextStep.action === "publish_review"
                  ? "Publish"
                  : nextStep.action === "reply_comments"
                    ? "Run next step"
                    : nextStep.action === "merge_ready" || nextStep.action === "ignored" || nextStep.action === "idle" || nextStep.action === "busy"
                      ? undefined
                      : "Run next step"
            : undefined,
        tone: nextStep.tone,
        onClick: nextStep.canExecute
          ? () => executeNextStep.mutate({ repo, prNumber })
          : undefined,
        disabled: executeNextStep.isPending || !nextStep.canExecute,
      }
    : null;

  const renderCard = (c: EnrichedComment, opts?: { onRetryFix?: () => void; onFix?: () => void }) => (
    <CommentCard
      key={c.id}
      comment={c}
      onDismiss={() => dismiss.mutate({ repo, prNumber, commentId: c.id })}
      onReopen={() => reopen.mutate({ repo, prNumber, commentId: c.id })}
      onRecategorize={(category) => recategorize.mutate({ repo, prNumber, commentId: c.id, category })}
      onRetryFix={opts?.onRetryFix}
      onFix={opts?.onFix}
      onReanalyze={() =>
        runGuardedAction("analyze_github", {
          actionLabel: "analysis",
          confirmLabel: "Analyze again",
          run: () => analyze.mutate({ repo, prNumber, commentIds: [c.id], analyzerAgent: selectedAnalyzerAgent }),
        })
      }
    />
  );

  return (
    <div className="space-y-4">
      <PROverview
        repo={repo}
        prNumber={prNumber}
        onRequestReview={runRequestReviewAction}
        onRefreshReview={runRefreshReviewAction}
        coordinatorIgnored={coordinatorPreference?.ignored ?? false}
        coordinatorBusy={updateCoordinatorPreference.isPending}
        onToggleCoordinatorIgnore={() =>
          updateCoordinatorPreference.mutate({
            repo,
            prNumber,
            ignored: !(coordinatorPreference?.ignored ?? false),
          })
        }
      />

      {/* Analysis progress panel (scoped to this PR) */}
      {(analyze.progressFor(repo, prNumber) || analyzeLocal.progressFor(repo, prNumber)) && (
        <AnalysisProgressPanel progress={(analyze.progressFor(repo, prNumber) ?? analyzeLocal.progressFor(repo, prNumber))!} />
      )}

      {/* PR Timeline */}
      {(timeline || suggestedStep) && (
        <PRTimeline events={timeline ?? []} suggestion={suggestedStep} onViewDetails={setSelectedTimelineEvent} />
      )}
      <TimelineEventDetailsDialog
        repo={repo}
        prNumber={prNumber}
        event={selectedTimelineEvent}
        onClose={() => setSelectedTimelineEvent(null)}
      />

      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
            {githubComments.length} comment{githubComments.length !== 1 ? "s" : ""}
            </span>
          {unanalyzed.length > 0 && (
            <Badge variant="default">{unanalyzed.length} unanalyzed</Badge>
          )}
          {(mustFix.length + shouldFix.length) > 0 && (
            <Badge variant="must_fix">{mustFix.length + shouldFix.length} actionable</Badge>
          )}
          {fixedComments.length > 0 && (
            <Badge variant="fixed">{fixedComments.length} fixed</Badge>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <LocalAgentSelector
            value={selectedAnalyzerAgent}
            onChange={(value) => {
              setHasAnalyzerOverride(true);
              setSelectedAnalyzerAgent(value);
            }}
            prefix="Analyze with"
            disabled={analyze.isPending || !hasAvailableAnalyzer}
            options={analyzerAgentOptions}
          />
          <LocalAgentSelector
            value={selectedFixerAgent}
            onChange={(value) => {
              setHasFixerOverride(true);
              setSelectedFixerAgent(value);
            }}
            prefix="Fix with"
            disabled={isFixing || !hasAvailableFixer}
            options={fixerAgentOptions}
          />
          <Button
            variant="secondary"
            size="sm"
            className="active:scale-[0.96] transition-transform"
            onClick={() => refreshPR.mutate({ repo, prNumber }, { onSuccess: () => refetch() })}
            disabled={refreshPR.isPending}
            title="Sync latest comments from GitHub"
          >
            {refreshPR.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {refreshPR.isPending ? "Syncing..." : "Sync Comments"}
          </Button>
          {unanalyzed.length > 0 ? (
            <Button
              size="sm"
              className="active:scale-[0.96] transition-transform"
              onClick={runAnalyzeGitHub}
              disabled={analyze.isPending || !hasAvailableAnalyzer}
              title={hasAvailableAnalyzer ? `Run AI analysis with ${selectedAnalyzerLabel} to categorize unreviewed comments` : "Claude CLI or Codex CLI is not available"}
            >
              {analyze.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Analyze ({unanalyzed.length})
                </>
              )}
            </Button>
          ) : analyzedNotActioned.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              className="active:scale-[0.96] transition-transform"
              onClick={runReanalyzeGitHub}
              disabled={analyze.isPending || !hasAvailableAnalyzer}
              title={hasAvailableAnalyzer ? `Re-run analysis with ${selectedAnalyzerLabel} on previously categorized comments` : "Claude CLI or Codex CLI is not available"}
            >
              {analyze.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Re-analyzing...
                </>
              ) : (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Re-analyze ({analyzedNotActioned.length})
                </>
              )}
            </Button>
          ) : null}
          {fixableCount > 0 && (
            <Button
              size="sm"
              className="active:scale-[0.96] transition-transform"
              onClick={() => runFixGitHub()}
              disabled={isFixing || !hasAvailableFixer}
              title={hasAvailableFixer ? `Auto-fix all actionable issues using ${selectedFixerLabel}` : "Claude CLI or Codex CLI is not available"}
            >
              {isFixing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Fixing...
                </>
              ) : (
                <>
                  <Wrench className="h-3.5 w-3.5" />
                  Fix Issues ({fixableCount})
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <>
      {/* Analyzed — parent group with nested sub-categories */}
      <CollapsibleSection
        title="Analyzed"
        count={analyzedNotActioned.length + fixingComments.length + fixFailedComments.length}
        color="must_fix"
        badge={
          <span className="flex gap-1 ml-1">
            {mustFix.length > 0 && <Badge variant="must_fix">{mustFix.length} must fix</Badge>}
            {shouldFix.length > 0 && <Badge variant="should_fix">{shouldFix.length} should fix</Badge>}
            {fixFailedComments.length > 0 && <Badge variant="fix_failed">{fixFailedComments.length} failed</Badge>}
          </span>
        }
      >
        <CollapsibleSection title="Fixing" count={fixingComments.length} color="fixing" embedded>
          {fixingComments.map((c) => renderCard(c))}
        </CollapsibleSection>

        <CollapsibleSection title="Must Fix" count={mustFix.length} color="must_fix" embedded>
          {mustFix.map((c) => renderCard(c))}
        </CollapsibleSection>

        <CollapsibleSection title="Should Fix" count={shouldFix.length} color="should_fix" embedded>
          {shouldFix.map((c) => renderCard(c))}
        </CollapsibleSection>

        <CollapsibleSection
          title="Nice to Have"
          count={niceToHave.length}
          defaultOpen={false}
          color="nice_to_have"
          embedded
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => runFixGitHub(niceToHave.map((c) => c.id))}
              disabled={isFixing || !hasAvailableFixer}
            >
              <Wrench className="h-3 w-3" />
              Fix All ({niceToHave.length})
            </Button>
          }
        >
          {niceToHave.map((c) => renderCard(c, {
            onFix: hasAvailableFixer ? () => runFixGitHub([c.id]) : undefined,
          }))}
        </CollapsibleSection>

        <CollapsibleSection title="Fix Failed" count={fixFailedComments.length} color="fix_failed" embedded>
          {fixFailedComments.map((c) =>
            renderCard(c, {
              onRetryFix: hasAvailableFixer ? () => runFixGitHub([c.id]) : undefined,
            }),
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Already Addressed"
          count={alreadyAddressed.length}
          defaultOpen={false}
          color="already_addressed"
          opacity="opacity-75"
          embedded
        >
          {alreadyAddressed.map((c) => renderCard(c))}
        </CollapsibleSection>

        <CollapsibleSection
          title="Dismissed by Analysis"
          count={dismissedByAnalysis.length}
          defaultOpen={false}
          color="dismiss"
          opacity="opacity-75"
          embedded
        >
          {dismissedByAnalysis.map((c) => renderCard(c))}
        </CollapsibleSection>

      </CollapsibleSection>

      {/* Pending Analysis */}
      <CollapsibleSection title="Pending Analysis" count={unanalyzed.length} color="muted">
        {unanalyzed.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Fixed — grouped by commit */}
      <CollapsibleSection
        title="Fixed"
        count={fixedComments.length}
        defaultOpen={false}
        color="fixed"
        badge={(() => {
          const unreplied = fixedComments.filter((c) => c.type === "inline" && !c.repliedAt).length;
          if (unreplied === 0) return undefined;
          return (
            <Badge variant="should_fix" className="text-[9px] h-4 px-1.5">
              <MessageSquareReply className="h-2.5 w-2.5 mr-0.5" />
              {unreplied} unreplied
            </Badge>
          );
        })()}
        action={
          fixedComments.some((c) => c.type === "inline") ? (() => {
            const unrepliedCount = fixedComments.filter((c) => c.type === "inline" && !c.repliedAt).length;
            const allReplied = unrepliedCount === 0;
            return (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setShowReplyPreview(!showReplyPreview)}
              >
                {allReplied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <MessageSquareReply className="h-3 w-3" />
                )}
                {showReplyPreview ? "Hide" : allReplied ? "All Replied" : `Reply (${unrepliedCount})`}
              </Button>
            );
          })() : undefined
        }
      >
        {/* Reply preview panel */}
        {showReplyPreview && fixedComments.filter((c) => c.type === "inline").length > 0 && (() => {
          const inlineFixed = fixedComments.filter((c) => c.type === "inline");
          const unreplied = inlineFixed.filter((c) => !c.repliedAt && c.fixResult);
          const replied = inlineFixed.filter((c) => c.repliedAt);

          return (
            <Card className="overflow-hidden border-green-500/20 bg-green-500/5 mb-3">
              <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <MessageSquareReply className="h-4 w-4 text-green-500" />
                    Reply Preview
                    {replied.length > 0 && (
                      <Badge variant="fixed" className="text-[10px] h-4 px-1.5">
                        {replied.length} already replied
                      </Badge>
                    )}
                  </span>
                  {unreplied.length > 0 && (
                    <Button
                      size="sm"
                      className="h-7 text-xs px-3"
                      onClick={() =>
                        runGuardedAction("reply_comments", {
                          actionLabel: "reply",
                          confirmLabel: "Reply anyway",
                          run: () => {
                            const replies = unreplied.map((c) => ({
                              commentId: c.id,
                              body: "Addressed in " + c.fixResult!.commitHash,
                            }));
                            replyToComments.mutate({ repo, prNumber, replies }, {
                              onSuccess: () => setShowReplyPreview(false),
                            });
                          },
                        })
                      }
                      disabled={replyToComments.isPending}
                    >
                      {replyToComments.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      Send {unreplied.length} Repl{unreplied.length === 1 ? "y" : "ies"}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {inlineFixed.map((c) => (
                    <div key={c.id} className={`flex items-start gap-2 text-xs rounded p-2 ${c.repliedAt ? "bg-green-500/5 opacity-60" : "bg-background/50"}`}>
                      {c.repliedAt ? (
                        <Check className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                      ) : (
                        <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0">
                        <span className="font-mono text-muted-foreground">
                          {c.path}{c.line ? `:${c.line}` : ""}
                        </span>
                        <p className="text-muted-foreground mt-0.5 truncate">
                          {c.body.replace(/<[^>]*>/g, "").split("\n")[0].slice(0, 120)}
                        </p>
                        {c.repliedAt ? (
                          <p className="text-green-600 mt-1 text-[10px]">
                            Replied {new Date(c.repliedAt).toLocaleString()}
                          </p>
                        ) : (
                          <p className="text-green-600 mt-1 font-medium">
                            → Addressed in {c.fixResult?.commitHash ?? "commit"}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          );
        })()}
        {/* Group by commit hash */}
        {(() => {
          const byCommit = new Map<string, EnrichedComment[]>();
          for (const c of fixedComments) {
            const hash = c.fixResult?.commitHash ?? "unknown";
            if (!byCommit.has(hash)) byCommit.set(hash, []);
            byCommit.get(hash)!.push(c);
          }
          return [...byCommit.entries()].map(([hash, group]) => (
            <FixedCommitGroup
              key={hash}
              hash={hash}
              comments={group}
              onRevert={() => setRevertHash(hash)}
              revertPending={revertFix.isPending}
            />
          ));
        })()}
      </CollapsibleSection>

      {/* Manually Dismissed */}
      <CollapsibleSection
        title="Dismissed"
        count={dismissed.length}
        defaultOpen={false}
        color="dismiss"
        opacity="opacity-60"
      >
        {dismissed.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            onDismiss={() => {}}
            onReopen={() => reopen.mutate({ repo, prNumber, commentId: c.id })}
          />
        ))}
      </CollapsibleSection>
      </>

      {/* ═══════ LOCAL AI REVIEW COMMENTS ═══════ */}
      {allLocal.length > 0 && (
        <>
          {/* Local comments header bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {allLocal.length} local comment{allLocal.length !== 1 ? "s" : ""}
              </span>
              {localPending.length > 0 && (
                <Badge variant="default">{localPending.length} pending triage</Badge>
              )}
              {(localMustFix.length + localShouldFix.length) > 0 && (
                <Badge variant="must_fix">{localMustFix.length + localShouldFix.length} actionable</Badge>
              )}
              {localFixed.length > 0 && (
                <Badge variant="fixed">{localFixed.length} fixed</Badge>
              )}
              {publishable.length > 0 && (
                <Badge variant="outline" className="text-amber-400 border-amber-400/30">{publishable.length} unpublished</Badge>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <LocalAgentSelector
                value={selectedFixerAgent}
                onChange={(value) => {
                  setHasFixerOverride(true);
                  setSelectedFixerAgent(value);
                }}
                prefix="Fix with"
                disabled={isLocalFixing || !hasAvailableFixer}
                options={fixerAgentOptions}
              />
              {localPending.length > 0 && (
                <Button
                  size="sm"
                  className="active:scale-[0.96] transition-transform"
                  onClick={() => runAnalyzeLocal()}
                  disabled={isLocalAnalyzing}
                  title="Analyze local reviewer comments before deciding what is actionable"
                >
                  {isLocalAnalyzing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Triaging...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      Analyze ({localPending.length})
                    </>
                  )}
                </Button>
              )}
              {publishable.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="active:scale-[0.96] transition-transform"
                  onClick={runPublishAll}
                  disabled={publishReview.isPending}
                >
                  {publishReview.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Publish to GitHub
                </Button>
              )}
              {localFixableCount > 0 && (
                <Button
                  size="sm"
                  className="active:scale-[0.96] transition-transform"
                  onClick={() => runFixLocalAction()}
                  disabled={isLocalFixing || !hasAvailableFixer}
                  title={hasAvailableFixer ? `Fix local review issues using ${selectedFixerLabel}` : "Claude CLI or Codex CLI is not available"}
                >
                  {isLocalFixing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Fixing...
                    </>
                  ) : (
                    <>
                      <Wrench className="h-3.5 w-3.5" />
                      Fix Issues ({localFixableCount})
                    </>
                  )}
                </Button>
              )}
              {localFixing.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="active:scale-[0.96] transition-transform"
                  onClick={() => resetLocal.mutate({ repo, prNumber })}
                  disabled={resetLocal.isPending}
                  title="Reset stuck comments from 'fixing' back to 'analyzed'"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset Stuck
                </Button>
              )}
            </div>
          </div>

          <CollapsibleSection title="Pending Triage" count={localPending.length} color="muted">
            {localPending.map((c) => (
              <LocalReviewCommentCard
                key={c.id}
                comment={c}
                onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
              />
            ))}
          </CollapsibleSection>

          <CollapsibleSection
            title="Triaged"
            count={localAnalyzed.length + localFixing.length + localFixFailed.length}
            color="must_fix"
            badge={
              <span className="flex gap-1 ml-1">
                {localMustFix.length > 0 && <Badge variant="must_fix">{localMustFix.length} must fix</Badge>}
                {localShouldFix.length > 0 && <Badge variant="should_fix">{localShouldFix.length} should fix</Badge>}
                {localFixFailed.length > 0 && <Badge variant="fix_failed">{localFixFailed.length} failed</Badge>}
              </span>
            }
          >
            <CollapsibleSection title="Fixing" count={localFixing.length} color="fixing" embedded>
              {localFixing.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                />
              ))}
            </CollapsibleSection>

            <CollapsibleSection title="Must Fix" count={localMustFix.length} color="must_fix" embedded>
              {localMustFix.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                  onFix={hasAvailableFixer ? () => runFixLocalAction([c.id]) : undefined}
                />
              ))}
            </CollapsibleSection>

            <CollapsibleSection title="Should Fix" count={localShouldFix.length} color="should_fix" embedded>
              {localShouldFix.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                  onFix={hasAvailableFixer ? () => runFixLocalAction([c.id]) : undefined}
                />
              ))}
            </CollapsibleSection>

            <CollapsibleSection title="Nice to Have" count={localNiceToHave.length} defaultOpen={false} color="nice_to_have" embedded>
              {localNiceToHave.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                  onFix={hasAvailableFixer ? () => runFixLocalAction([c.id]) : undefined}
                />
              ))}
            </CollapsibleSection>

            <CollapsibleSection title="Fix Failed" count={localFixFailed.length} color="fix_failed" embedded>
              {localFixFailed.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                  onFix={hasAvailableFixer ? () => runFixLocalAction([c.id]) : undefined}
                />
              ))}
            </CollapsibleSection>

            <CollapsibleSection title="Already Addressed" count={localAlreadyAddressed.length} defaultOpen={false} color="already_addressed" opacity="opacity-75" embedded>
              {localAlreadyAddressed.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                />
              ))}
            </CollapsibleSection>

            <CollapsibleSection title="Dismissed by Analysis" count={localDismissedByAnalysis.length} defaultOpen={false} color="dismiss" opacity="opacity-75" embedded>
              {localDismissedByAnalysis.map((c) => (
                <LocalReviewCommentCard
                  key={c.id}
                  comment={c}
                  onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                  onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                  onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
                />
              ))}
            </CollapsibleSection>
          </CollapsibleSection>

          <CollapsibleSection title="Fixed" count={localFixed.length} defaultOpen={false} color="fixed">
            {localFixed.map((c) => (
              <LocalReviewCommentCard
                key={c.id}
                comment={c}
                onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
              />
            ))}
          </CollapsibleSection>

          <CollapsibleSection title="Superseded" count={localSuperseded.length} defaultOpen={false} color="muted" opacity="opacity-70">
            {localSuperseded.map((c) => (
              <LocalReviewCommentCard
                key={c.id}
                comment={c}
                onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
              />
            ))}
          </CollapsibleSection>

          <CollapsibleSection title="Dismissed" count={localDismissed.length} defaultOpen={false} color="dismiss" opacity="opacity-60">
            {localDismissed.map((c) => (
              <LocalReviewCommentCard
                key={c.id}
                comment={c}
                onDismiss={() => dismissLocal.mutate({ repo, prNumber, commentId: c.id })}
                onDelete={() => deleteLocal.mutate({ repo, prNumber, commentId: c.id })}
                onRecategorize={(category) => recategorizeLocal.mutate({ repo, prNumber, commentId: c.id, category })}
                onAnalyze={() => runAnalyzeLocal(c.reviewerId, [c.id])}
              />
            ))}
          </CollapsibleSection>
        </>
      )}

      <ConfirmDialog
        open={revertHash !== null}
        title="Revert fix commit"
        description={`This will create a revert commit for ${revertHash} on the PR branch and roll back all associated comments to "analyzed" state. Continue?`}
        confirmLabel="Revert"
        variant="destructive"
        onConfirm={() => {
          if (revertHash) {
            revertFix.mutate({ repo, prNumber, commitHash: revertHash });
          }
          setRevertHash(null);
        }}
        onCancel={() => setRevertHash(null)}
      />
      <ConfirmDialog
        open={guardDialog !== null}
        title={guardDialog?.title ?? "Repeat action?"}
        description={guardDialog?.description ?? ""}
        confirmLabel={guardDialog?.confirmLabel ?? "Continue"}
        onConfirm={() => {
          const onConfirm = guardDialog?.onConfirm;
          setGuardDialog(null);
          onConfirm?.();
        }}
        onCancel={() => setGuardDialog(null)}
      />
    </div>
  );
}
