import { usePRComments, useAnalyze, useDismiss, useReopen, useRecategorize, useFixComments, useRevertFix, useReplyToComments, usePRStatus, useRefreshPR, type EnrichedComment, type AnalysisProgressState, type FixProgress } from "../hooks/useApi";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { MarkdownBody } from "./MarkdownBody";
import { Card } from "./ui/card";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { ReviewScoreboard } from "./ReviewScoreboard";
import {
  Bot,
  FileCode,
  Sparkles,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
  Wrench,
  Check,
  AlertCircle,
  RotateCcw,
  RefreshCw,
  History,
  Undo2,
  MessageSquareReply,
  Send,
  Users,
  LayoutList,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

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
};

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
              <div className="px-3 pb-2">
                {comment.analysis.reasoning}
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

        {/* Live Claude output */}
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

            {/* Claude output */}
            <OutputLog lines={progress.output} />
          </div>
        </div>
      </div>
    </div>
  );
}

function FixCyclesPanel({ phase, reviewCycle, lastFixedAt, current, history }: {
  phase: string;
  reviewCycle: number;
  lastFixedAt: string | null;
  current: FixProgress | null;
  history: FixProgress[];
}) {
  const runs = [
    ...(current ? [current] : []),
    ...[...history].reverse(),
  ];
  const [open, setOpen] = useState(!!current);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Status header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => runs.length > 0 && setOpen(!open)}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && runs.length > 0) { e.preventDefault(); setOpen(!open); } }}
        className={[
          "flex items-center gap-3 px-3 h-[40px] select-none",
          runs.length > 0 ? "cursor-pointer hover:bg-white/[0.04] active:bg-white/[0.06]" : "",
          "transition-colors duration-100",
          open ? "bg-white/[0.02]" : "",
        ].join(" ")}
      >
        <Badge variant={phaseVariant[phase] ?? "outline"}>
          {phaseLabel[phase] ?? phase}
        </Badge>
        {reviewCycle > 0 && (
          <span className="text-xs text-muted-foreground">
            Cycle #{reviewCycle}
          </span>
        )}
        {lastFixedAt && (
          <span className="text-xs text-muted-foreground ml-auto">
            Last fixed: {new Date(lastFixedAt).toLocaleString()}
          </span>
        )}
        {runs.length > 0 && (
          <>
            {!lastFixedAt && <span className="ml-auto" />}
            <span className="text-[11px] tabular-nums text-muted-foreground/50">
              {runs.length} run{runs.length !== 1 ? "s" : ""}
            </span>
            <ChevronRight
              className={[
                "h-3 w-3 text-muted-foreground/40 transition-transform duration-200 ease-out",
                open ? "rotate-90" : "",
              ].join(" ")}
            />
          </>
        )}
      </div>

      {/* Expandable run list */}
      {runs.length > 0 && (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            <div className="divide-y divide-border border-t border-border">
              {runs.map((run, i) => (
                <FixProgressPanel
                  key={run.startedAt}
                  progress={run}
                  collapsed={i > 0}
                  embedded
                />
              ))}
            </div>
          </div>
        </div>
      )}
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

const phaseLabel: Record<string, string> = {
  polled: "Polled",
  analyzed: "Analyzed",
  fixing: "Fixing...",
  fixed: "Fixed",
  re_review_requested: "Re-review Requested",
  waiting_for_review: "Waiting for Review",
};

const phaseVariant: Record<string, "fixing" | "fixed" | "default" | "outline"> = {
  fixing: "fixing",
  fixed: "fixed",
  re_review_requested: "fixed",
  waiting_for_review: "outline",
};

export function CommentView({ repo, prNumber }: CommentViewProps) {
  const { data: comments, isLoading, refetch } = usePRComments(repo, prNumber);
  const analyze = useAnalyze();
  const dismiss = useDismiss();
  const reopen = useReopen();
  const recategorize = useRecategorize();
  const fixMutation = useFixComments();
  const revertFix = useRevertFix();
  const replyToComments = useReplyToComments();
  const refreshPR = useRefreshPR();
  const { data: prStatus } = usePRStatus(repo, prNumber);
  const [revertHash, setRevertHash] = useState<string | null>(null);
  const [showReplyPreview, setShowReplyPreview] = useState(false);
  const [groupBy, setGroupBy] = useState<"category" | "reviewer">("category");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading comments...
      </div>
    );
  }

  if (!comments?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Bot className="h-8 w-8 mb-3 opacity-40" />
        <p className="text-sm">No bot comments on this PR</p>
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

  // Group by status
  const unanalyzed = comments.filter(
    (c) => c.status === "new" || (!c.analysis && c.status !== "dismissed"),
  );
  const fixingComments = comments.filter((c) => c.status === "fixing");
  const fixFailedComments = comments.filter((c) => c.status === "fix_failed");
  const fixedComments = comments.filter((c) => c.status === "fixed");
  const dismissed = comments.filter((c) => c.status === "dismissed");

  // Group analyzed comments by category
  const analyzedNotActioned = comments.filter(
    (c) =>
      c.analysis &&
      !["fixed", "fixing", "fix_failed", "dismissed"].includes(c.status),
  );

  const mustFix = analyzedNotActioned.filter((c) => c.analysis?.category === "MUST_FIX");
  const shouldFix = analyzedNotActioned.filter((c) => c.analysis?.category === "SHOULD_FIX");
  const niceToHave = analyzedNotActioned.filter((c) => c.analysis?.category === "NICE_TO_HAVE");
  const dismissedByAnalysis = analyzedNotActioned.filter((c) => c.analysis?.category === "DISMISS");
  const alreadyAddressed = analyzedNotActioned.filter((c) => c.analysis?.category === "ALREADY_ADDRESSED");

  const fixableCount =
    prStatus?.fixableCount ??
    mustFix.length + shouldFix.length + fixFailedComments.length;
  const isFixing = fixMutation.isPending || prStatus?.phase === "fixing";

  const renderCard = (c: EnrichedComment, opts?: { onRetryFix?: () => void; onFix?: () => void }) => (
    <CommentCard
      key={c.id}
      comment={c}
      onDismiss={() => dismiss.mutate({ repo, prNumber, commentId: c.id })}
      onReopen={() => reopen.mutate({ repo, prNumber, commentId: c.id })}
      onRecategorize={(category) => recategorize.mutate({ repo, prNumber, commentId: c.id, category })}
      onRetryFix={opts?.onRetryFix}
      onFix={opts?.onFix}
      onReanalyze={() => analyze.mutate({ repo, prNumber, commentIds: [c.id] })}
    />
  );

  return (
    <div className="space-y-4">
      {/* Review Scoreboard */}
      <ReviewScoreboard repo={repo} prNumber={prNumber} />

      {/* Analysis progress panel (scoped to this PR) */}
      {analyze.progressFor(repo, prNumber) && (
        <AnalysisProgressPanel progress={analyze.progressFor(repo, prNumber)!} />
      )}

      {/* PR status + fix cycles */}
      {prStatus && prStatus.phase !== "polled" && (
        <FixCyclesPanel
          phase={prStatus.phase}
          reviewCycle={prStatus.reviewCycle}
          lastFixedAt={prStatus.lastFixedAt}
          current={prStatus.fixProgress}
          history={prStatus.fixHistory ?? []}
        />
      )}

      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {comments.length} comment{comments.length !== 1 ? "s" : ""}
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
          {/* Group toggle */}
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              className={`px-2 py-1 text-xs flex items-center gap-1 ${groupBy === "category" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
              onClick={() => setGroupBy("category")}
              title="Group by category"
            >
              <LayoutList className="h-3 w-3" />
              Category
            </button>
            <button
              className={`px-2 py-1 text-xs flex items-center gap-1 border-l border-border ${groupBy === "reviewer" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
              onClick={() => setGroupBy("reviewer")}
              title="Group by reviewer"
            >
              <Users className="h-3 w-3" />
              Reviewer
            </button>
          </div>
        </div>
        <div className="flex gap-2">
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
              onClick={() => analyze.mutate({ repo, prNumber })}
              disabled={analyze.isPending}
              title="Run AI analysis to categorize unreviewed comments"
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
              onClick={() =>
                analyze.mutate({
                  repo,
                  prNumber,
                  commentIds: analyzedNotActioned.map((c) => c.id),
                })
              }
              disabled={analyze.isPending}
              title="Re-run analysis on previously categorized comments"
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
              onClick={() => fixMutation.mutate({ repo, prNumber })}
              disabled={isFixing}
              title="Auto-fix all actionable issues in the codebase"
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

      {groupBy === "reviewer" ? (
        /* ---- Group by Reviewer view ---- */
        (() => {
          const byReviewer = new Map<string, EnrichedComment[]>();
          for (const c of comments) {
            if (!byReviewer.has(c.user)) byReviewer.set(c.user, []);
            byReviewer.get(c.user)!.push(c);
          }
          return [...byReviewer.entries()].map(([reviewer, reviewerComments]) => {
            const counts = {
              mustFix: reviewerComments.filter((c) => c.analysis?.category === "MUST_FIX" && !["fixed", "fixing", "fix_failed", "dismissed"].includes(c.status)).length,
              shouldFix: reviewerComments.filter((c) => c.analysis?.category === "SHOULD_FIX" && !["fixed", "fixing", "fix_failed", "dismissed"].includes(c.status)).length,
              fixed: reviewerComments.filter((c) => c.status === "fixed").length,
              dismissed: reviewerComments.filter((c) => c.status === "dismissed").length,
            };
            return (
              <CollapsibleSection
                key={reviewer}
                title={reviewer}
                count={reviewerComments.length}
                badge={
                  <span className="flex gap-1 ml-1">
                    {counts.mustFix > 0 && <Badge variant="must_fix">{counts.mustFix}</Badge>}
                    {counts.shouldFix > 0 && <Badge variant="should_fix">{counts.shouldFix}</Badge>}
                    {counts.fixed > 0 && <Badge variant="fixed">{counts.fixed}</Badge>}
                  </span>
                }
              >
                {reviewerComments.map((c) =>
                  renderCard(c, {
                    onRetryFix: c.status === "fix_failed" ? () => fixMutation.mutate({ repo, prNumber, commentIds: [c.id] }) : undefined,
                    onFix: c.analysis?.category === "NICE_TO_HAVE" && !["fixed", "fixing"].includes(c.status) ? () => fixMutation.mutate({ repo, prNumber, commentIds: [c.id] }) : undefined,
                  }),
                )}
              </CollapsibleSection>
            );
          });
        })()
      ) : (
        /* ---- Group by Category view (default) ---- */
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
              onClick={() => fixMutation.mutate({ repo, prNumber, commentIds: niceToHave.map((c) => c.id) })}
              disabled={isFixing}
            >
              <Wrench className="h-3 w-3" />
              Fix All ({niceToHave.length})
            </Button>
          }
        >
          {niceToHave.map((c) => renderCard(c, {
            onFix: () => fixMutation.mutate({ repo, prNumber, commentIds: [c.id] }),
          }))}
        </CollapsibleSection>

        <CollapsibleSection title="Fix Failed" count={fixFailedComments.length} color="fix_failed" embedded>
          {fixFailedComments.map((c) =>
            renderCard(c, {
              onRetryFix: () => fixMutation.mutate({ repo, prNumber, commentIds: [c.id] }),
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
                      onClick={() => {
                        const replies = unreplied.map((c) => ({
                          commentId: c.id,
                          body: "Addressed in " + c.fixResult!.commitHash,
                        }));
                        replyToComments.mutate({ repo, prNumber, replies }, {
                          onSuccess: () => setShowReplyPreview(false),
                        });
                      }}
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
    </div>
  );
}
