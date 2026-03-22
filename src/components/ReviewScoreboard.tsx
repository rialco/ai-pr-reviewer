import {
  useAvailableReviewers,
  useReviews,
  useRequestReview,
  useRefreshReview,
  useReviewComments,
  type ReviewerInfo,
  type Review,
  type ReviewProgressState,
} from "../hooks/useApi";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { AgentLogo } from "./ui/agent-logo";
import { SectionHeader } from "./ui/section-header";
import {
  Loader2,
  RefreshCw,
  Play,
  Check,
  AlertCircle,
  FileText,
  X,
  MessageSquare,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface ReviewScoreboardProps {
  repo: string;
  prNumber: number;
  embedded?: boolean;
  title?: string;
  className?: string;
  onRequestReview?: (reviewerId: string) => void;
  onRefreshReview?: (reviewerId: string) => void;
}

type ReviewerGroupKind = "bot" | "local-ai";

function scoreAccent(score: number | null): { text: string; ring: string; bg: string } {
  if (score === null) return { text: "text-muted-foreground/50", ring: "ring-muted-foreground/20", bg: "bg-muted-foreground/5" };
  if (score >= 4) return { text: "text-emerald-400", ring: "ring-emerald-400/40", bg: "bg-emerald-400/8" };
  if (score >= 3) return { text: "text-amber-400", ring: "ring-amber-400/40", bg: "bg-amber-400/8" };
  return { text: "text-rose-400", ring: "ring-rose-400/40", bg: "bg-rose-400/8" };
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Summary Dialog ─────────────────────────────────────────── */
type SummaryTab = "structured" | "raw";

function SummaryDialog({
  open,
  reviewerName,
  summary,
  rawOutput,
  score,
  onClose,
}: {
  open: boolean;
  reviewerName: string;
  summary: string;
  rawOutput: string | null;
  score: number | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SummaryTab>("structured");

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const accent = scoreAccent(score);
  const hasBothTabs = !!rawOutput;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-50 w-full max-w-2xl rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/60">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold">{reviewerName}</span>
            {score !== null && (
              <span className={`text-xs font-mono font-medium ${accent.text}`}>
                {score}/5
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Tabs */}
        {hasBothTabs && (
          <div className="flex gap-0 px-5 pt-3 border-b border-border/40">
            {(["structured", "raw"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-3 pb-2 text-[11px] font-medium uppercase tracking-wide transition-colors border-b-2 -mb-px",
                  tab === t
                    ? "text-foreground border-primary"
                    : "text-muted-foreground/60 border-transparent hover:text-muted-foreground",
                )}
              >
                {t === "structured" ? "Summary" : "Raw Output"}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {tab === "structured" ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {summary}
            </p>
          ) : (
            <pre className="text-[11px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap break-words font-mono bg-muted/30 rounded-lg p-3 border border-border/30">
              {rawOutput}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Action Icon Button with feedback ───────────────────────── */
function ActionIconButton({
  icon: Icon,
  onClick,
  disabled,
  loading,
  title,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  title: string;
  label?: string;
}) {
  const [flashed, setFlashed] = useState(false);

  const handleClick = useCallback(() => {
    onClick();
    setFlashed(true);
  }, [onClick]);

  useEffect(() => {
    if (!flashed) return;
    const t = setTimeout(() => setFlashed(false), 400);
    return () => clearTimeout(t);
  }, [flashed]);

  return (
    <button
      onClick={handleClick}
      disabled={disabled || loading}
      title={title}
      className={`
        inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] whitespace-nowrap
        text-muted-foreground transition-all duration-150
        hover:text-foreground hover:bg-muted
        active:scale-[0.93] active:bg-secondary
        disabled:pointer-events-none disabled:opacity-40
        ${flashed ? "text-foreground bg-muted" : ""}
      `}
    >
      {loading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {label && <span>{label}</span>}
    </button>
  );
}

/* ── Score Indicator ────────────────────────────────────────── */
function ScoreIndicator({ score }: { score: number | null }) {
  const accent = scoreAccent(score);

  return (
    <div className={`
      inline-flex items-center justify-center
      min-w-[44px] h-[26px] rounded-full
      ring-1 ${accent.ring} ${accent.bg}
      tabular-nums font-semibold text-xs
      ${accent.text}
    `}>
      {score !== null ? (
        <span>{score}<span className="text-[10px] opacity-60">/5</span></span>
      ) : (
        <span className="text-[10px]">--</span>
      )}
    </div>
  );
}

/* ── Progress Strip ─────────────────────────────────────────── */
function ProgressStrip({ state }: { state: ReviewProgressState }) {
  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <div className="flex items-center gap-3 flex-wrap">
        {state.steps.map((step, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[10px]">
            {step.status === "done" ? (
              <Check className="h-2.5 w-2.5 text-emerald-400" />
            ) : (
              <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
            )}
            <span className={step.status === "done" ? "text-muted-foreground/60" : "text-foreground"}>
              {step.message}
            </span>
          </div>
        ))}
      </div>
      {state.error && (
        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-destructive">
          <AlertCircle className="h-2.5 w-2.5" />
          {state.error}
        </div>
      )}
      <div className="h-[3px] w-full rounded-full bg-muted overflow-hidden mt-2">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${state.progress}%` }}
        />
      </div>
    </div>
  );
}

function AnimatedProgressStrip({ state }: { state: ReviewProgressState | null }) {
  const [renderedState, setRenderedState] = useState<ReviewProgressState | null>(state);
  const [visible, setVisible] = useState(Boolean(state));

  useEffect(() => {
    if (state) {
      setRenderedState(state);
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setVisible(false);
    const timeout = window.setTimeout(() => {
      setRenderedState(null);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [state]);

  if (!renderedState) return null;

  return (
    <div
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out",
        visible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="overflow-hidden">
        <div
          className={cn(
            "px-1 pb-1 transition-[transform,opacity] duration-200 ease-out",
            visible ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
          )}
        >
          <ProgressStrip state={renderedState} />
        </div>
      </div>
    </div>
  );
}

function ReviewerGroupSection({
  title,
  pipClassName,
  reviewers,
  reviewMap,
  commentsByReviewer,
  requestReview,
  refreshReview,
  repo,
  prNumber,
  onRequestReview,
  onRefreshReview,
}: {
  title: string;
  pipClassName: string;
  reviewers: ReviewerInfo[];
  reviewMap: Map<string, Review>;
  commentsByReviewer: Map<string, number>;
  requestReview: ReturnType<typeof useRequestReview>;
  refreshReview: ReturnType<typeof useRefreshReview>;
  repo: string;
  prNumber: number;
  onRequestReview?: (reviewerId: string) => void;
  onRefreshReview?: (reviewerId: string) => void;
}) {
  if (reviewers.length === 0) return null;

  const availableReviewers = reviewers.filter((reviewer) => reviewer.available);
  const hasPending = reviewers.some((reviewer) => requestReview.isPendingFor(repo, prNumber, reviewer.id));
  const hasExistingReview = reviewers.some((reviewer) => reviewMap.has(reviewer.id));
  const bulkLabel = hasExistingReview ? "Re-review all" : "Review all";

  return (
    <div>
      <SectionHeader
        title={title}
        pipClassName={pipClassName}
        className="h-9 border-b border-border/40 bg-transparent px-1.5"
        detail={
          <div className="flex items-center gap-2">
            <span>{reviewers.length}</span>
            {availableReviewers.length > 0 ? (
              <ActionIconButton
                icon={Play}
                onClick={() => {
                  for (const reviewer of availableReviewers) {
                    if (onRequestReview) {
                      onRequestReview(reviewer.id);
                    } else {
                      requestReview.mutate({ repo, prNumber, reviewerId: reviewer.id });
                    }
                  }
                }}
                disabled={hasPending}
                loading={hasPending}
                title={`${bulkLabel} for ${title.toLowerCase()}`}
                label={bulkLabel}
              />
            ) : null}
          </div>
        }
      />
      <div className="divide-y divide-border/30">
        {reviewers.map((reviewer) => (
          <ReviewerRow
            key={reviewer.id}
            reviewer={reviewer}
            review={reviewMap.get(reviewer.id) ?? null}
            commentCount={commentsByReviewer.get(reviewer.id) ?? 0}
            onRequest={() => {
              if (onRequestReview) {
                onRequestReview(reviewer.id);
              } else {
                requestReview.mutate({ repo, prNumber, reviewerId: reviewer.id });
              }
            }}
            onRefresh={() => {
              if (onRefreshReview) {
                onRefreshReview(reviewer.id);
              } else {
                refreshReview.mutate({ repo, prNumber, reviewerId: reviewer.id });
              }
            }}
            isRequesting={requestReview.isPendingFor(repo, prNumber, reviewer.id)}
            progressState={requestReview.progressFor(repo, prNumber, reviewer.id)}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Reviewer Row ───────────────────────────────────────────── */
function ReviewerRow({
  reviewer,
  review,
  commentCount,
  onRequest,
  onRefresh,
  isRequesting,
  progressState,
}: {
  reviewer: ReviewerInfo;
  review: Review | null;
  commentCount: number;
  onRequest: () => void;
  onRefresh: () => void;
  isRequesting: boolean;
  progressState: ReviewProgressState | null;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const hasScore = review?.confidenceScore !== null && review?.confidenceScore !== undefined;
  const canRefresh = reviewer.type === "bot" && hasScore;

  return (
    <>
      <div className="group flex min-w-0 items-center gap-3 py-2 px-1">
        {/* Reviewer identity */}
        <div className="flex min-w-[120px] flex-1 items-center gap-2">
          <AgentLogo agent={reviewer.id} className="h-3.5 w-3.5 shrink-0" />
          <span className="text-xs font-medium truncate">{reviewer.displayName}</span>
          {reviewer.type === "local-ai" && (
            <Badge variant="outline" className="text-[9px] h-4 px-1">local</Badge>
          )}
        </div>

        {/* Score pill */}
        <ScoreIndicator score={review?.confidenceScore ?? null} />

        {/* Comment count badge */}
        {commentCount > 0 && (
          <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5">
            <MessageSquare className="h-2.5 w-2.5" />
            {commentCount}
          </span>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-muted-foreground/50 min-w-[48px]">
          {review?.createdAt ? timeAgo(review.createdAt) : ""}
        </span>

        {/* Actions */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          {canRefresh && (
            <ActionIconButton
              icon={RefreshCw}
              onClick={onRefresh}
              title="Re-fetch this review"
              label="Refresh"
            />
          )}
          {reviewer.available && (
            <ActionIconButton
              icon={Play}
              onClick={onRequest}
              disabled={isRequesting}
              loading={isRequesting}
              title={hasScore ? "Request a new review" : "Request review"}
              label={hasScore ? "Re-review" : "Review"}
            />
          )}
          {review?.summary && (
            <ActionIconButton
              icon={FileText}
              onClick={() => setSummaryOpen(true)}
              title="View review details"
              label="Details"
            />
          )}
        </div>
      </div>

      {/* Progress — inline under the row */}
      <AnimatedProgressStrip state={progressState} />

      {/* Summary dialog */}
      {review?.summary && (
        <SummaryDialog
          open={summaryOpen}
          reviewerName={reviewer.displayName}
          summary={review.summary}
          rawOutput={review.rawOutput}
          score={review.confidenceScore}
          onClose={() => setSummaryOpen(false)}
        />
      )}
    </>
  );
}

/* ── Main Scoreboard ────────────────────────────────────────── */
export function ReviewScoreboard({
  repo,
  prNumber,
  embedded = false,
  title = "Confidence Scores",
  className,
  onRequestReview,
  onRefreshReview,
}: ReviewScoreboardProps) {
  const { data: reviewers } = useAvailableReviewers();
  const { data: reviews } = useReviews(repo, prNumber);
  const { data: allComments } = useReviewComments(repo, prNumber);
  const requestReview = useRequestReview();
  const refreshReview = useRefreshReview();

  // Group comments by reviewerId
  const commentsByReviewer = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of allComments ?? []) {
      map.set(c.reviewerId, (map.get(c.reviewerId) ?? 0) + 1);
    }
    return map;
  }, [allComments]);

  if (!reviewers) return null;

  const reviewMap = new Map<string, Review>();
  for (const r of reviews ?? []) {
    reviewMap.set(r.reviewerId, r);
  }

  const groupedReviewers = reviewers.reduce<Record<ReviewerGroupKind, ReviewerInfo[]>>(
    (acc, reviewer) => {
      acc[reviewer.type].push(reviewer);
      return acc;
    },
    { bot: [], "local-ai": [] },
  );

  const content = (
    <div className={cn(embedded ? "flex h-full flex-col px-0 py-0" : "px-4 py-3", className)}>
      {title ? (
        <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground/70">
          {title}
        </span>
      ) : null}
      <div className={cn("space-y-3", title ? "mt-1.5" : "")}>
        <ReviewerGroupSection
          title="Online Reviewers"
          pipClassName="bg-sky-400"
          reviewers={groupedReviewers.bot}
          reviewMap={reviewMap}
          commentsByReviewer={commentsByReviewer}
          requestReview={requestReview}
          refreshReview={refreshReview}
          repo={repo}
          prNumber={prNumber}
          onRequestReview={onRequestReview}
          onRefreshReview={onRefreshReview}
        />
        <ReviewerGroupSection
          title="Local Reviewers"
          pipClassName="bg-emerald-400"
          reviewers={groupedReviewers["local-ai"]}
          reviewMap={reviewMap}
          commentsByReviewer={commentsByReviewer}
          requestReview={requestReview}
          refreshReview={refreshReview}
          repo={repo}
          prNumber={prNumber}
          onRequestReview={onRequestReview}
          onRefreshReview={onRefreshReview}
        />
      </div>
    </div>
  );

  if (embedded) return content;

  return (
    <Card className="overflow-hidden">
      {content}
    </Card>
  );
}
