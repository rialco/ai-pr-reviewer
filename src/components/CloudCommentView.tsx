import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronRight, ExternalLink, FileCode, GitBranch, GitCommitHorizontal, Github, Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { MarkdownBody } from "./MarkdownBody";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SectionHeader } from "./ui/section-header";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";

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
  if (eventType === "review_publish_failed") return "Review publish failed";
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
    case "comments_fetched":
      return `${typeof d.machineSlug === "string" ? d.machineSlug : "worker"} synced ${typeof d.commentCount === "number" ? d.commentCount : 0} comment(s)`;
    case "analysis_requested":
      return `${localAgentLabel(typeof d.analyzerAgent === "string" ? d.analyzerAgent : undefined)} queued ${typeof d.count === "number" ? d.count : 0} comment(s)`;
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
    case "fix_no_changes":
    case "local_fix_no_changes":
      return `${localAgentLabel(typeof d.fixerAgent === "string" ? d.fixerAgent : undefined)} produced no diff`;
    case "comments_replied":
      return `${typeof d.count === "number" ? d.count : 0} comment(s) replied`;
    case "review_requested":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} requested`;
    case "review_completed":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} • ${d.confidenceScore ?? "--"}/5 • ${d.commentCount ?? 0} comments`;
    case "review_publish_requested":
      return `${typeof d.reviewerId === "string" ? localAgentLabel(d.reviewerId) : "Reviewer"} publish queued`;
    case "comment_recategorized":
      return `Set category to ${typeof d.category === "string" ? d.category : "unknown"}`;
    default:
      return null;
  }
}

export function CloudCommentView({ repo, prNumber }: CloudCommentViewProps) {
  const { activeWorkspaceId } = useActiveWorkspace();
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
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [selectedTimelineEventId, setSelectedTimelineEventId] = useState<string | null>(null);
  const [timelineTab, setTimelineTab] = useState<"history" | "parameters" | "prompt">("history");
  const [selectedReviewerId, setSelectedReviewerId] = useState<"claude" | "codex" | null>(null);
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
  const pendingReviewCommentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of reviewComments ?? []) {
      if (comment.status !== "new" && comment.status !== "analyzing") {
        continue;
      }
      counts.set(comment.reviewerId, (counts.get(comment.reviewerId) ?? 0) + 1);
    }
    return counts;
  }, [reviewComments]);
  const fixableReviewCommentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of reviewComments ?? []) {
      if (
        comment.analysisCategory !== "MUST_FIX" &&
        comment.analysisCategory !== "SHOULD_FIX"
      ) {
        continue;
      }
      if (comment.status !== "analyzed" && comment.status !== "fix_failed") {
        continue;
      }
      counts.set(comment.reviewerId, (counts.get(comment.reviewerId) ?? 0) + 1);
    }
    return counts;
  }, [reviewComments]);
  const publishableReviewCommentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of reviewComments ?? []) {
      if (comment.publishedAt || comment.supersededAt) {
        continue;
      }
      if (comment.status !== "analyzed") {
        continue;
      }
      if (
        comment.analysisCategory === "DISMISS" ||
        comment.analysisCategory === "ALREADY_ADDRESSED"
      ) {
        continue;
      }
      counts.set(comment.reviewerId, (counts.get(comment.reviewerId) ?? 0) + 1);
    }
    return counts;
  }, [reviewComments]);
  const botUsers = detail?.repoBotUsers ?? [];
  const githubComments = detail?.comments ?? [];
  const pendingGithubCommentCount = useMemo(
    () =>
      githubComments.filter(
        (comment) =>
          botUsers.includes(comment.user) &&
          (comment.status === "new" || comment.status === "analyzing"),
      ).length,
    [botUsers, githubComments],
  );
  const fixableGithubCommentCount = useMemo(
    () =>
      githubComments.filter(
        (comment) =>
          botUsers.includes(comment.user) &&
          (comment.status === "analyzed" || comment.status === "fix_failed") &&
          (comment.analysisCategory === "MUST_FIX" || comment.analysisCategory === "SHOULD_FIX"),
      ).length,
    [botUsers, githubComments],
  );
  const replyableGithubCommentCount = useMemo(
    () =>
      githubComments.filter(
        (comment) =>
          botUsers.includes(comment.user) &&
          comment.type === "inline" &&
          comment.status === "fixed" &&
          !comment.repliedAt &&
          !!comment.fixCommitHash,
      ).length,
    [botUsers, githubComments],
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

  useEffect(() => {
    setTimelineTab("history");
  }, [selectedTimelineEventId]);

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

  const handleAnalyzeReviewComments = async (
    reviewerId: "claude" | "codex",
    analyzerAgent: "claude" | "codex",
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
      });
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAnalyzeGithubComments = async (analyzerAgent: "claude" | "codex") => {
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
                    {selectedMachineRecord?.capabilities.claude ? (
                      <Button variant="outline" size="sm" disabled={!selectedMachineSlug} onClick={() => void handleRequestReview("claude")}>
                        Review with Claude
                      </Button>
                    ) : null}
                    {selectedMachineRecord?.capabilities.codex ? (
                      <Button variant="outline" size="sm" disabled={!selectedMachineSlug} onClick={() => void handleRequestReview("codex")}>
                        Review with Codex
                      </Button>
                    ) : null}
                  </>
                ) : null}
                <a href={pr.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open on GitHub
                  </Button>
                </a>
              </div>
            </div>
          </div>
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

        <Card className="overflow-hidden bg-surface">
          <SectionHeader title="Timeline" detail={timeline?.length ?? 0} pipClassName="bg-muted-foreground/40" />
          <div className="p-4">
            {timeline && timeline.length > 0 ? (
              <div className="space-y-2">
                {timeline.slice(0, 10).map((event) => {
                  const detailSummary = formatTimelineDetail(event);
                  return (
                    <div key={event._id} className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm text-foreground/88">{timelineLabel(event.eventType)}</div>
                          {detailSummary ? (
                            <div className="mt-1 text-xs text-muted-foreground">{detailSummary}</div>
                          ) : null}
                          <div className="mt-1 text-[10px] text-muted-foreground/70">
                            {formatRelativeTime(event.createdAt)} • {formatTimestamp(event.createdAt)}
                          </div>
                        </div>
                        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setSelectedTimelineEventId(event._id)}>
                          <ChevronRight className="h-3.5 w-3.5" />
                          View details
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No cloud timeline entries yet for this PR.</p>
            )}
          </div>
        </Card>

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

            <div className="mt-3 flex flex-wrap justify-end gap-2">
              {pendingGithubCommentCount > 0 && selectedMachineRecord?.capabilities.claude ? (
                <Button variant="outline" size="sm" onClick={() => void handleAnalyzeGithubComments("claude")}>
                  Triage with Claude
                </Button>
              ) : null}
              {pendingGithubCommentCount > 0 && selectedMachineRecord?.capabilities.codex ? (
                <Button variant="outline" size="sm" onClick={() => void handleAnalyzeGithubComments("codex")}>
                  Triage with Codex
                </Button>
              ) : null}
              {fixableGithubCommentCount > 0 && selectedMachineRecord?.capabilities.claude ? (
                <Button variant="outline" size="sm" onClick={() => void handleFixGithubComments("claude")}>
                  Fix with Claude
                </Button>
              ) : null}
              {fixableGithubCommentCount > 0 && selectedMachineRecord?.capabilities.codex ? (
                <Button variant="outline" size="sm" onClick={() => void handleFixGithubComments("codex")}>
                  Fix with Codex
                </Button>
              ) : null}
              {replyableGithubCommentCount > 0 && selectedMachineRecord?.capabilities.gh ? (
                <Button variant="outline" size="sm" onClick={() => void handleReplyToGithubComments()}>
                  Reply addressed
                </Button>
              ) : null}
            </div>

            {comments.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-6 text-sm text-muted-foreground">
                No synced GitHub comments for this PR yet.
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {comments.map((comment) => {
                  const isBotComment = botUsers.includes(comment.user);
                  const selectedCategory = comment.analysisCategory ?? "UNTRIAGED";

                  return (
                    <Card key={comment._id} className="border-white/8 bg-zinc-900/55 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{comment.user}</Badge>
                            <CommentTypeBadge type={comment.type} />
                            {comment.path ? (
                              <Badge variant="outline">
                                {comment.path}
                                {comment.line ? `:${comment.line}` : ""}
                              </Badge>
                            ) : null}
                            {isBotComment ? <Badge variant="outline">{comment.status}</Badge> : null}
                            {isBotComment ? (
                              <Badge
                                variant={categoryVariant[comment.analysisCategory ?? "UNTRIAGED"] ?? "outline"}
                              >
                                {categoryLabel[comment.analysisCategory ?? "UNTRIAGED"] ?? comment.analysisCategory}
                              </Badge>
                            ) : null}
                            <span className="text-xs text-muted-foreground">{formatTimestamp(comment.updatedAt)}</span>
                          </div>
                        </div>

                        {isBotComment ? (
                          <div className="flex flex-wrap items-center justify-end gap-2">
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
                        ) : null}
                      </div>

                      <div className="mt-3 text-sm leading-6 text-foreground/88">
                        <MarkdownBody text={comment.body} />
                      </div>

                      {isBotComment && comment.analysisReasoning ? (
                        <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-100/90">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
                            Triage Reasoning
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                            {comment.analysisReasoning}
                          </p>
                          {comment.analysisDetails?.confidence != null || comment.analysisDetails?.accessMode ? (
                            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-emerald-100/75">
                              {comment.analysisDetails?.confidence != null ? (
                                <Badge variant="outline">Confidence {comment.analysisDetails.confidence}/5</Badge>
                              ) : null}
                              {comment.analysisDetails?.accessMode ? (
                                <Badge variant="outline">
                                  {comment.analysisDetails.accessMode === "FULL_CODEBASE" ? "Full Codebase" : "Diff Only"}
                                </Badge>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {isBotComment && comment.fixCommitHash ? (
                        <div className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-sm text-sky-100/90">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">
                            Fix Result
                          </p>
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
                      {isBotComment && comment.repliedAt ? (
                        <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-sm text-violet-100/90">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300/80">
                            Reply Posted
                          </p>
                          <p className="mt-2 text-sm leading-6">
                            Replied on {formatTimestamp(comment.repliedAt)}
                          </p>
                          {comment.replyBody ? (
                            <p className="mt-1 text-xs text-violet-100/80">{comment.replyBody}</p>
                          ) : null}
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
              <div className="space-y-2">
                {(["claude", "codex"] as const).map((reviewerId) => {
                  const pendingCount = pendingReviewCommentCounts.get(reviewerId) ?? 0;
                  const fixableCount = fixableReviewCommentCounts.get(reviewerId) ?? 0;
                  const publishableCount = publishableReviewCommentCounts.get(reviewerId) ?? 0;
                  if (pendingCount === 0 && fixableCount === 0 && publishableCount === 0) return null;

                  return (
                    <div
                      key={`${reviewerId}-actions`}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-black/10 px-3 py-2"
                    >
                      <span className="text-xs text-muted-foreground">
                        {getAgentLabel(reviewerId)}
                        {pendingCount > 0 ? ` · ${pendingCount} pending triage` : ""}
                        {fixableCount > 0 ? ` · ${fixableCount} ready to fix` : ""}
                        {publishableCount > 0 ? ` · ${publishableCount} ready to publish` : ""}
                      </span>
                      {pendingCount > 0 && selectedMachineRecord.capabilities.claude ? (
                        <Button variant="outline" size="sm" onClick={() => void handleAnalyzeReviewComments(reviewerId, "claude")}>
                          Triage with Claude
                        </Button>
                      ) : null}
                      {pendingCount > 0 && selectedMachineRecord.capabilities.codex ? (
                        <Button variant="outline" size="sm" onClick={() => void handleAnalyzeReviewComments(reviewerId, "codex")}>
                          Triage with Codex
                        </Button>
                      ) : null}
                      {fixableCount > 0 && selectedMachineRecord.capabilities.claude ? (
                        <Button variant="outline" size="sm" onClick={() => void handleFixReviewComments(reviewerId, "claude")}>
                          Fix with Claude
                        </Button>
                      ) : null}
                      {fixableCount > 0 && selectedMachineRecord.capabilities.codex ? (
                        <Button variant="outline" size="sm" onClick={() => void handleFixReviewComments(reviewerId, "codex")}>
                          Fix with Codex
                        </Button>
                      ) : null}
                      {publishableCount > 0 && selectedMachineRecord.capabilities.gh ? (
                        <Button variant="outline" size="sm" onClick={() => void handlePublishReview(reviewerId)}>
                          Publish to GitHub
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {reviewComments && reviewComments.length > 0 ? (
              <div className="mt-3 space-y-3">
                {reviewComments.map((comment) => (
                  <div key={comment._id} className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{getAgentLabel(comment.reviewerId)}</Badge>
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
                    {comment.analysisReasoning ? (
                      <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-100/90">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
                          Triage Reasoning
                        </p>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                          {comment.analysisReasoning}
                        </p>
                      </div>
                    ) : null}
                    {comment.fixCommitHash ? (
                      <div className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-sm text-sky-100/90">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">
                          Fix Result
                        </p>
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
                      <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-sm text-violet-100/90">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300/80">
                          Published
                        </p>
                        <p className="mt-2 text-sm leading-6">
                          Sent to GitHub on {formatTimestamp(comment.publishedAt)}
                        </p>
                      </div>
                    ) : null}
                  </div>
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

            return (
              <div className="space-y-4">
                {detailSummary ? (
                  <div className="rounded-lg border border-white/8 bg-black/10 px-3 py-3 text-sm text-muted-foreground">
                    {detailSummary}
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
        title={selectedReviewerSummary ? getAgentLabel(selectedReviewerSummary.reviewerId) : "Review details"}
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
            {selectedReviewerSummary.latestReview.summary ? (
              <div className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                <MarkdownBody text={selectedReviewerSummary.latestReview.summary} />
              </div>
            ) : null}
            {selectedReviewerSummary.latestReview.rawOutput ? (
              <pre className="overflow-x-auto rounded-lg border border-white/8 bg-black/10 p-3 text-xs leading-6 text-muted-foreground">
                {selectedReviewerSummary.latestReview.rawOutput}
              </pre>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
