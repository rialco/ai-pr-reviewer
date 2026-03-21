import {
  useAvailableReviewers,
  useReviews,
  useRequestReview,
  useRefreshReview,
  type ReviewerInfo,
  type Review,
  type ReviewProgressState,
} from "../hooks/useApi";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import {
  Loader2,
  RefreshCw,
  Play,
  Check,
  AlertCircle,
  Bot,
  Cpu,
  FileText,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { useState, useEffect, useCallback } from "react";

interface ReviewScoreboardProps {
  repo: string;
  prNumber: number;
}

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
function SummaryDialog({
  open,
  reviewerName,
  summary,
  score,
  onClose,
}: {
  open: boolean;
  reviewerName: string;
  summary: string;
  score: number | null;
  onClose: () => void;
}) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-50 w-full max-w-lg rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
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
            className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* Body */}
        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          <p className="text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {summary}
          </p>
        </div>
      </div>
    </div>
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
        inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]
        text-muted-foreground transition-all duration-150
        hover:text-foreground hover:bg-white/[0.06]
        active:scale-[0.93] active:bg-white/[0.10]
        disabled:pointer-events-none disabled:opacity-40
        ${flashed ? "text-foreground bg-white/[0.08]" : ""}
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
      <div className="h-[3px] w-full rounded-full bg-white/[0.04] overflow-hidden mt-2">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${state.progress}%` }}
        />
      </div>
    </div>
  );
}

/* ── Reviewer Row ───────────────────────────────────────────── */
function ReviewerRow({
  reviewer,
  review,
  onRequest,
  onRefresh,
  isRequesting,
  progressState,
}: {
  reviewer: ReviewerInfo;
  review: Review | null;
  onRequest: () => void;
  onRefresh: () => void;
  isRequesting: boolean;
  progressState: ReviewProgressState | null;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const hasScore = review?.confidenceScore !== null && review?.confidenceScore !== undefined;

  return (
    <>
      <div className="group flex items-center gap-3 py-2 px-1">
        {/* Reviewer identity */}
        <div className="flex items-center gap-2 min-w-[120px]">
          {reviewer.type === "bot" ? (
            <Bot className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          ) : (
            <Cpu className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          )}
          <span className="text-xs font-medium truncate">{reviewer.displayName}</span>
          {reviewer.type === "local-ai" && (
            <Badge variant="outline" className="text-[9px] h-4 px-1">local</Badge>
          )}
        </div>

        {/* Score pill */}
        <ScoreIndicator score={review?.confidenceScore ?? null} />

        {/* Timestamp */}
        <span className="text-[10px] text-muted-foreground/50 min-w-[48px]">
          {review?.createdAt ? timeAgo(review.createdAt) : ""}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-0.5 ml-auto opacity-60 group-hover:opacity-100 transition-opacity">
          {hasScore && (
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
              title="View review summary"
              label="Summary"
            />
          )}
        </div>
      </div>

      {/* Progress — inline under the row */}
      {progressState && (
        <div className="px-1 pb-1">
          <ProgressStrip state={progressState} />
        </div>
      )}

      {/* Summary dialog */}
      {review?.summary && (
        <SummaryDialog
          open={summaryOpen}
          reviewerName={reviewer.displayName}
          summary={review.summary}
          score={review.confidenceScore}
          onClose={() => setSummaryOpen(false)}
        />
      )}
    </>
  );
}

/* ── Main Scoreboard ────────────────────────────────────────── */
export function ReviewScoreboard({ repo, prNumber }: ReviewScoreboardProps) {
  const { data: reviewers } = useAvailableReviewers();
  const { data: reviews } = useReviews(repo, prNumber);
  const requestReview = useRequestReview();
  const refreshReview = useRefreshReview();

  if (!reviewers) return null;

  const reviewMap = new Map<string, Review>();
  for (const r of reviews ?? []) {
    reviewMap.set(r.reviewerId, r);
  }

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3">
        <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground/70">
          Confidence Scores
        </span>
        <div className="mt-1.5 divide-y divide-border/30">
          {reviewers.map((reviewer) => (
            <ReviewerRow
              key={reviewer.id}
              reviewer={reviewer}
              review={reviewMap.get(reviewer.id) ?? null}
              onRequest={() =>
                requestReview.mutate({ repo, prNumber, reviewerId: reviewer.id })
              }
              onRefresh={() =>
                refreshReview.mutate({ repo, prNumber, reviewerId: reviewer.id })
              }
              isRequesting={requestReview.isPendingFor(repo, prNumber, reviewer.id)}
              progressState={requestReview.progressFor(repo, prNumber, reviewer.id)}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}
