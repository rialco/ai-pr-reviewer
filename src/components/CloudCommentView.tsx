import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ExternalLink, FileCode, GitBranch, GitCommitHorizontal, Github, Loader2, MessageSquare, Minus, Plus, RefreshCw, History } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { MarkdownBody } from "./MarkdownBody";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface CloudCommentViewProps {
  repo: string;
  prNumber: number;
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function CommentTypeBadge({ type }: { type: "inline" | "review" | "issue_comment" }) {
  const label =
    type === "inline" ? "Inline comment" : type === "review" ? "Review note" : "Issue comment";

  return <Badge variant="outline">{label}</Badge>;
}

function timelineLabel(eventType: string) {
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

  return (
    <div className="space-y-6 px-6 py-5">
      <Card className="overflow-hidden border-white/10 bg-zinc-900/70">
        <div className="border-b border-white/8 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant="outline">#{pr.prNumber}</Badge>
                <Badge variant="outline">{pr.author}</Badge>
                <span className="text-xs text-muted-foreground">Updated {formatTimestamp(pr.updatedAt)}</span>
              </div>
              <h1 className="text-xl font-semibold leading-tight text-foreground/90">{pr.title}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
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
                <span className="inline-flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {comments.length} GitHub comment{comments.length === 1 ? "" : "s"}
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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedMachineSlug}
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh PR
                  </Button>
                  {selectedMachineRecord?.capabilities.claude ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!selectedMachineSlug}
                      onClick={() => void handleRequestReview("claude")}
                    >
                      Review with Claude
                    </Button>
                  ) : null}
                  {selectedMachineRecord?.capabilities.codex ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!selectedMachineSlug}
                      onClick={() => void handleRequestReview("codex")}
                    >
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

        <div className="grid gap-5 px-6 py-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.9fr)]">
          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                PR Body
              </p>
              {pr.body.trim() ? (
                <div className="mt-3 rounded-xl border border-white/8 bg-black/10 px-4 py-4">
                  <MarkdownBody text={pr.body} />
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No PR description was provided.</p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  GitHub Comments
                </p>
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
              {publishError ? (
                <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {publishError}
                </div>
              ) : null}

              {comments.length === 0 ? (
                <div className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-6 text-sm text-muted-foreground">
                  No synced GitHub comments for this PR yet.
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {selectedMachineRecord ? (
                    <div className="flex flex-wrap gap-2 rounded-xl border border-white/8 bg-black/10 px-3 py-3">
                      <span className="text-xs text-muted-foreground">
                        {pendingGithubCommentCount > 0 ? `${pendingGithubCommentCount} pending triage` : "No pending triage"}
                        {fixableGithubCommentCount > 0 ? ` · ${fixableGithubCommentCount} ready to fix` : ""}
                        {replyableGithubCommentCount > 0 ? ` · ${replyableGithubCommentCount} ready to reply` : ""}
                      </span>
                      {pendingGithubCommentCount > 0 && selectedMachineRecord.capabilities.claude ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleAnalyzeGithubComments("claude")}
                        >
                          Triage with Claude
                        </Button>
                      ) : null}
                      {pendingGithubCommentCount > 0 && selectedMachineRecord.capabilities.codex ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleAnalyzeGithubComments("codex")}
                        >
                          Triage with Codex
                        </Button>
                      ) : null}
                      {fixableGithubCommentCount > 0 && selectedMachineRecord.capabilities.claude ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleFixGithubComments("claude")}
                        >
                          Fix with Claude
                        </Button>
                      ) : null}
                      {fixableGithubCommentCount > 0 && selectedMachineRecord.capabilities.codex ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleFixGithubComments("codex")}
                        >
                          Fix with Codex
                        </Button>
                      ) : null}
                      {replyableGithubCommentCount > 0 && selectedMachineRecord.capabilities.gh ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleReplyToGithubComments()}
                        >
                          Reply addressed
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {comments.map((comment) => (
                    <Card key={comment._id} className="border-white/8 bg-zinc-900/55 p-4">
                      {(() => {
                        const isBotComment = botUsers.includes(comment.user);
                        return (
                          <>
                      <div className="flex flex-wrap items-center gap-2">
                        <CommentTypeBadge type={comment.type} />
                        <Badge variant="outline">{comment.user}</Badge>
                        {comment.path ? <Badge variant="outline">{comment.path}{comment.line ? `:${comment.line}` : ""}</Badge> : null}
                        {isBotComment ? <Badge variant="outline">{comment.status}</Badge> : null}
                        {isBotComment && comment.analysisCategory ? <Badge variant="outline">{comment.analysisCategory}</Badge> : null}
                        <span className="text-xs text-muted-foreground">{formatTimestamp(comment.updatedAt)}</span>
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
                          </>
                        );
                      })()}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <Card className="border-white/8 bg-zinc-900/45 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Merge State
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="outline">{pr.mergeable ?? "UNKNOWN"}</Badge>
                <Badge variant="outline">{pr.mergeStateStatus ?? "UNKNOWN"}</Badge>
                {pr.phase ? <Badge variant="outline">Phase: {pr.phase}</Badge> : null}
              </div>
            </Card>

            <Card className="border-white/8 bg-zinc-900/45 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Changed Files
              </p>
              {previewFiles.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {previewFiles.map((file) => (
                    <div key={file.path} className="rounded-lg border border-white/8 bg-black/10 px-3 py-2">
                      <div className="truncate text-sm text-foreground/88">{file.path}</div>
                      <div className="mt-1 flex items-center gap-3 text-xs">
                        <span className="text-emerald-400">+{file.additions}</span>
                        <span className="text-rose-400">-{file.deletions}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No file metadata was synced yet.</p>
              )}
            </Card>

            <Card className="border-white/8 bg-zinc-900/45 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Reviews
              </p>
              {reviews && reviews.length > 0 ? (
                <div className="mt-3 space-y-3">
                  {reviews.map((review) => (
                    <div key={review._id} className="rounded-lg border border-white/8 bg-black/10 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{review.reviewerId}</Badge>
                        {review.confidenceScore !== undefined && review.confidenceScore !== null ? (
                          <Badge variant="outline">{review.confidenceScore}/5</Badge>
                        ) : null}
                        <Badge variant="outline">{review.commentCount} comment{review.commentCount === 1 ? "" : "s"}</Badge>
                        <span className="text-xs text-muted-foreground">{formatTimestamp(review.updatedAt)}</span>
                      </div>
                      {review.summary ? (
                        <div className="mt-3 text-sm leading-6 text-foreground/88">
                          <MarkdownBody text={review.summary} />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No cloud review runs yet for this PR.</p>
              )}
            </Card>

            <Card className="border-white/8 bg-zinc-900/45 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Review Comments
              </p>
              {selectedMachineRecord ? (
                <div className="mt-3 space-y-2">
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
                          {reviewerId}
                          {pendingCount > 0
                            ? ` · ${pendingCount} pending triage`
                            : ""}
                          {fixableCount > 0
                            ? `${pendingCount > 0 ? " · " : " · "}${fixableCount} ready to fix`
                            : ""}
                          {publishableCount > 0
                            ? `${pendingCount > 0 || fixableCount > 0 ? " · " : " · "}${publishableCount} ready to publish`
                            : ""}
                        </span>
                        {pendingCount > 0 && selectedMachineRecord.capabilities.claude ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleAnalyzeReviewComments(reviewerId, "claude")}
                          >
                            Triage with Claude
                          </Button>
                        ) : null}
                        {pendingCount > 0 && selectedMachineRecord.capabilities.codex ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleAnalyzeReviewComments(reviewerId, "codex")}
                          >
                            Triage with Codex
                          </Button>
                        ) : null}
                        {fixableCount > 0 && selectedMachineRecord.capabilities.claude ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleFixReviewComments(reviewerId, "claude")}
                          >
                            Fix with Claude
                          </Button>
                        ) : null}
                        {fixableCount > 0 && selectedMachineRecord.capabilities.codex ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleFixReviewComments(reviewerId, "codex")}
                          >
                            Fix with Codex
                          </Button>
                        ) : null}
                        {publishableCount > 0 && selectedMachineRecord.capabilities.gh ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handlePublishReview(reviewerId)}
                          >
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
                        <Badge variant="outline">{comment.reviewerId}</Badge>
                        <Badge variant="outline">{comment.path}:{comment.line}</Badge>
                        <Badge variant="outline">{comment.status}</Badge>
                        {comment.analysisCategory ? (
                          <Badge variant="outline">{comment.analysisCategory}</Badge>
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
            </Card>

            <Card className="border-white/8 bg-zinc-900/45 p-4">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Timeline
                </p>
              </div>
              {timeline && timeline.length > 0 ? (
                <div className="mt-3 space-y-3">
                  {timeline.slice(0, 8).map((event) => (
                    <div key={event._id} className="rounded-lg border border-white/8 bg-black/10 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-foreground/88">{timelineLabel(event.eventType)}</span>
                        <span className="text-[10px] text-muted-foreground">{formatTimestamp(event.createdAt)}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {"machineSlug" in event.detail && typeof event.detail.machineSlug === "string" ? `${event.detail.machineSlug}` : null}
                        {"commentCount" in event.detail && typeof event.detail.commentCount === "number" ? ` · ${event.detail.commentCount} comments` : null}
                        {"changedFiles" in event.detail && typeof event.detail.changedFiles === "number" ? ` · ${event.detail.changedFiles} files` : null}
                        {"errorMessage" in event.detail && typeof event.detail.errorMessage === "string" ? ` · ${event.detail.errorMessage}` : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No cloud timeline entries yet for this PR.</p>
              )}
            </Card>

            <Card className="border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 text-amber-300" />
                <div className="text-sm text-amber-100/90">
                  GitHub PR detail, review requests, local comment triage, fixes, and review publishing are cloud-backed now. Reply flows are still on the remaining migration path.
                </div>
              </div>
            </Card>
          </div>
        </div>
      </Card>
    </div>
  );
}
