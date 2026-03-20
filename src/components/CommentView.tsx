import { usePRComments, useAnalyze, useDismiss, useReopen, useRecategorize, useFixComments, useRevertFix, useReplyToComments, useRequestReReview, usePRStatus, useRefreshPR, type EnrichedComment, type AnalysisProgressState, type FixProgress } from "../hooks/useApi";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { MarkdownBody } from "./MarkdownBody";
import { Card } from "./ui/card";
import { ConfirmDialog } from "./ui/confirm-dialog";
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
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onRetryFix} title="Retry fix">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            {comment.analysis && onReanalyze && comment.status !== "fixed" && comment.status !== "fixing" && (
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onReanalyze} title="Re-analyze">
                <Sparkles className="h-3.5 w-3.5" />
              </Button>
            )}
            {onFix && comment.status !== "fixed" && comment.status !== "fixing" && (
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onFix} title="Fix this issue">
                <Wrench className="h-3.5 w-3.5" />
              </Button>
            )}
            {comment.analysis && onRecategorize && comment.status !== "fixed" && comment.status !== "fixing" && (
              <select
                className="h-7 text-[10px] rounded border border-border bg-background text-muted-foreground px-1 cursor-pointer hover:border-foreground/30"
                value={comment.analysis.category}
                onChange={(e) => onRecategorize(e.target.value)}
              >
                <option value="MUST_FIX">Must Fix</option>
                <option value="SHOULD_FIX">Should Fix</option>
                <option value="NICE_TO_HAVE">Nice to Have</option>
                <option value="ALREADY_ADDRESSED">Already Addressed</option>
                <option value="DISMISS">Dismiss</option>
              </select>
            )}
            {comment.status === "dismissed" && onReopen && (
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onReopen} title="Reopen">
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {!comment.analysis && comment.status !== "dismissed" && comment.status !== "fixed" && (
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onDismiss} title="Dismiss">
                <X className="h-3.5 w-3.5" />
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

function CollapsibleSection({
  title,
  count,
  badge,
  action,
  defaultOpen = true,
  opacity,
  children,
}: {
  title: string;
  count: number;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  opacity?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (count === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 text-left group"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {title}
          </h3>
          <span className="text-xs text-muted-foreground/70">({count})</span>
          {badge}
        </button>
        {open && action}
      </div>
      {open && (
        <div className={`space-y-2 ${opacity ?? ""}`}>
          {children}
        </div>
      )}
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

function FixProgressPanel({ progress, collapsed: initialCollapsed }: { progress: FixProgress; collapsed?: boolean }) {
  const hasError = progress.steps.some((s) => s.status === "error");
  const allDone = progress.steps.every((s) => s.status === "done");
  const [collapsed, setCollapsed] = useState(initialCollapsed ?? false);

  const borderClass = hasError ? "border-destructive/30 bg-destructive/5" : "border-orange-500/20 bg-orange-500/5";

  return (
    <Card className={`overflow-hidden ${borderClass}`}>
      <div className="p-4">
        <button
          className="flex items-center gap-2 w-full text-left"
          onClick={() => setCollapsed(!collapsed)}
        >
          {allDone ? (
            <Check className="h-4 w-4 text-green-500 shrink-0" />
          ) : hasError ? (
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-orange-500 shrink-0" />
          )}
          <span className="text-sm font-medium">
            {hasError ? "Fix Failed" : allDone ? "Fix Complete" : "Fixing Issues"}
          </span>
          <span className="text-xs text-muted-foreground ml-auto">
            {new Date(progress.startedAt).toLocaleTimeString()}
            {progress.finishedAt && ` — ${new Date(progress.finishedAt).toLocaleTimeString()}`}
          </span>
          {collapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </button>

        {!collapsed && (
          <>
            <div className="space-y-1.5 mt-3">
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
            </div>

            {/* Claude output */}
            <OutputLog lines={progress.output} />
          </>
        )}
      </div>
    </Card>
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
    <div className="space-y-2 border border-border/50 rounded-md p-2">
      <div className="flex items-center justify-between">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-left">
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
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
        </button>
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
      </div>
      {open && (
        <div className="space-y-2">
          {comments.map((c) => (
            <CommentCard key={c.id} comment={c} onDismiss={() => {}} />
          ))}
        </div>
      )}
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
  const requestReReview = useRequestReReview();
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
      {/* PR Status Banner */}
      {prStatus && prStatus.phase !== "polled" && (
        <div className="flex items-center gap-3 rounded-md bg-muted/50 px-4 py-2.5 border border-border">
          <Badge variant={phaseVariant[prStatus.phase] ?? "outline"}>
            {phaseLabel[prStatus.phase] ?? prStatus.phase}
          </Badge>
          {prStatus.reviewCycle > 0 && (
            <span className="text-xs text-muted-foreground">
              Cycle #{prStatus.reviewCycle}
            </span>
          )}
          {prStatus.confidenceScore !== null && (
            <Badge variant={prStatus.confidenceScore >= 4 ? "confidence_high" : "confidence_low"}>
              {prStatus.confidenceScore}/5
            </Badge>
          )}
          {prStatus.lastFixedAt && (
            <span className="text-xs text-muted-foreground ml-auto">
              Last fixed: {new Date(prStatus.lastFixedAt).toLocaleString()}
            </span>
          )}
        </div>
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
            onClick={() => refreshPR.mutate({ repo, prNumber }, { onSuccess: () => refetch() })}
            disabled={refreshPR.isPending}
          >
            {refreshPR.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
          {unanalyzed.length > 0 ? (
            <Button
              size="sm"
              onClick={() => analyze.mutate({ repo, prNumber })}
              disabled={analyze.isPending}
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
              onClick={() =>
                analyze.mutate({
                  repo,
                  prNumber,
                  commentIds: analyzedNotActioned.map((c) => c.id),
                })
              }
              disabled={analyze.isPending}
            >
              {analyze.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Re-analyzing...
                </>
              ) : (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Re-analyze All ({analyzedNotActioned.length})
                </>
              )}
            </Button>
          ) : null}
          {fixableCount > 0 && (
            <Button
              size="sm"
              onClick={() => fixMutation.mutate({ repo, prNumber })}
              disabled={isFixing}
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => requestReReview.mutate({ repo, prNumber })}
            disabled={requestReReview.isPending}
          >
            {requestReReview.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Re-review
          </Button>
        </div>
      </div>

      {/* Analysis progress panel (scoped to this PR) */}
      {analyze.progressFor(repo, prNumber) && (
        <AnalysisProgressPanel progress={analyze.progressFor(repo, prNumber)!} />
      )}

      {/* Fix progress panel */}
      {prStatus?.fixProgress && (
        <FixProgressPanel progress={prStatus.fixProgress} />
      )}

      {/* Run history */}
      {prStatus?.fixHistory && prStatus.fixHistory.length > 0 && (
        <CollapsibleSection
          title="Run History"
          count={prStatus.fixHistory.length}
          defaultOpen={false}
          badge={<History className="h-3 w-3 text-muted-foreground ml-1" />}
        >
          <div className="space-y-2">
            {[...prStatus.fixHistory].reverse().map((run, i) => (
              <FixProgressPanel key={run.startedAt} progress={run} collapsed />
            ))}
          </div>
        </CollapsibleSection>
      )}

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
      {/* Fixing */}
      <CollapsibleSection title="Fixing" count={fixingComments.length}>
        {fixingComments.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Must Fix */}
      <CollapsibleSection
        title="Must Fix"
        count={mustFix.length}
        badge={<Badge variant="must_fix" className="ml-1">{mustFix.length}</Badge>}
      >
        {mustFix.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Should Fix */}
      <CollapsibleSection
        title="Should Fix"
        count={shouldFix.length}
        badge={<Badge variant="should_fix" className="ml-1">{shouldFix.length}</Badge>}
      >
        {shouldFix.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Nice to Have */}
      <CollapsibleSection
        title="Nice to Have"
        count={niceToHave.length}
        defaultOpen={false}
        badge={<Badge variant="nice_to_have" className="ml-1">{niceToHave.length}</Badge>}
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

      {/* Fix Failed */}
      <CollapsibleSection title="Fix Failed" count={fixFailedComments.length}>
        {fixFailedComments.map((c) =>
          renderCard(c, {
            onRetryFix: () => fixMutation.mutate({ repo, prNumber, commentIds: [c.id] }),
          }),
        )}
      </CollapsibleSection>

      {/* Pending Analysis */}
      <CollapsibleSection title="Pending Analysis" count={unanalyzed.length}>
        {unanalyzed.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Fixed — grouped by commit */}
      <CollapsibleSection
        title="Fixed"
        count={fixedComments.length}
        defaultOpen={false}
        opacity="opacity-75"
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

      {/* Already Addressed */}
      <CollapsibleSection
        title="Already Addressed"
        count={alreadyAddressed.length}
        defaultOpen={false}
        opacity="opacity-75"
      >
        {alreadyAddressed.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Dismissed by Analysis */}
      <CollapsibleSection
        title="Dismissed by Analysis"
        count={dismissedByAnalysis.length}
        defaultOpen={false}
        opacity="opacity-75"
      >
        {dismissedByAnalysis.map((c) => renderCard(c))}
      </CollapsibleSection>

      {/* Manually Dismissed */}
      <CollapsibleSection
        title="Dismissed"
        count={dismissed.length}
        defaultOpen={false}
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
