import { useEffect, useRef, useState } from "react";
import { usePROverview } from "../hooks/useApi";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SectionHeader } from "./ui/section-header";
import { MarkdownBody } from "./MarkdownBody";
import { ReviewScoreboard } from "./ReviewScoreboard";
import { cn } from "@/lib/utils";
import { getGitHubMergeStateDetails } from "@/lib/githubMergeState";
import {
  AlertTriangle,
  ExternalLink,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";

interface PROverviewProps {
  repo: string;
  prNumber: number;
  onRequestReview?: (reviewerId: string) => void;
  onRefreshReview?: (reviewerId: string) => void;
  coordinatorIgnored?: boolean;
  coordinatorBusy?: boolean;
  onToggleCoordinatorIgnore?: () => void;
}

export function PROverview({
  repo,
  prNumber,
  onRequestReview,
  onRefreshReview,
  coordinatorIgnored = false,
  coordinatorBusy = false,
  onToggleCoordinatorIgnore,
}: PROverviewProps) {
  const { data: overview, isLoading, error } = usePROverview(repo, prNumber);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [showBody, setShowBody] = useState(false);
  const stickySentinelRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(false);

  useEffect(() => {
    const sentinel = stickySentinelRef.current;
    if (!sentinel || typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      return;
    }

    let root: HTMLElement | null = sentinel.parentElement;
    while (root) {
      const overflowY = window.getComputedStyle(root).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        break;
      }
      root = root.parentElement;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsPinned(entry.intersectionRatio < 1);
      },
      {
        root,
        threshold: [1],
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  if (isLoading) {
    return (
      <Card className="overflow-hidden">
        <div className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading PR overview...
        </div>
      </Card>
    );
  }

  if (error || !overview) {
    return (
      <Card className="overflow-hidden">
        <div className="p-4 text-sm text-muted-foreground">
          PR overview is unavailable.
        </div>
      </Card>
    );
  }

  const hasLongBody = overview.body.trim().length > 500;
  const bodyText = overview.body.trim();
  const previewFiles = overview.files.slice(0, 5);
  const extraFiles = overview.files.slice(5);
  const mergeState = getGitHubMergeStateDetails(overview.mergeStateStatus);
  const showMergeBlocked = overview.needsConflictResolution || Boolean(mergeState?.isBlocked);
  const mergeStatePanelClassName =
    mergeState?.tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-50"
      : mergeState?.tone === "danger"
        ? "border-rose-500/30 bg-rose-500/8 text-rose-100"
        : mergeState?.tone === "warning"
          ? "border-amber-500/30 bg-amber-500/8 text-amber-100"
          : "border-white/10 bg-white/5 text-muted-foreground";

  return (
    <div className="relative space-y-4">
      <div
        ref={stickySentinelRef}
        className="pointer-events-none absolute inset-x-0 top-0 h-px w-full"
        aria-hidden
      />
      <div
        className={cn(
          "sticky top-0 z-20 transition-[padding-bottom] duration-200 ease-out",
          isPinned ? "pb-3" : "pb-1",
        )}
      >
        <section
          className={cn(
            "relative overflow-hidden border-b transition-[border-color,background-color,box-shadow,backdrop-filter] duration-200 ease-out",
            isPinned
              ? "border-white/10 bg-zinc-900/72 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-2xl"
              : "border-white/6 bg-zinc-800/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md",
          )}
          style={{ WebkitBackdropFilter: isPinned ? "blur(40px)" : "blur(12px)" }}
        >
          <div className="px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge variant="outline">#{overview.number}</Badge>
                  <Badge variant="outline">{overview.author}</Badge>
                  {showMergeBlocked && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                      Merge blocked
                    </Badge>
                  )}
                  {coordinatorIgnored && (
                    <Badge variant="outline" className="border-amber-500/30 text-amber-400">
                      Coordinator ignored
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Updated {new Date(overview.updatedAt).toLocaleString()}
                  </span>
                </div>
                <h1 className="text-xl font-semibold leading-tight text-foreground/88">{overview.title}</h1>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground/90">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" />
                    {overview.baseRefName} ← {overview.headRefName}
                  </span>
                  {mergeState && (
                    <span className={`inline-flex items-center gap-1.5 ${showMergeBlocked ? "text-amber-300" : ""}`}>
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {mergeState.label}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <FileCode className="h-3.5 w-3.5" />
                    {overview.changedFiles} file{overview.changedFiles !== 1 ? "s" : ""}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-emerald-400">
                    <Plus className="h-3.5 w-3.5" />
                    {overview.additions}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-rose-400">
                    <Minus className="h-3.5 w-3.5" />
                    {overview.deletions}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <GitCommitHorizontal className="h-3.5 w-3.5" />
                    {overview.commitCount} commit{overview.commitCount !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {onToggleCoordinatorIgnore && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={coordinatorBusy}
                    onClick={onToggleCoordinatorIgnore}
                  >
                    {coordinatorIgnored ? "Resume coordinator" : "Ignore for coordinator"}
                  </Button>
                )}
                <a
                  href={overview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                >
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open on GitHub
                  </Button>
                </a>
              </div>
            </div>
            {mergeState && (
              <div className={cn("mt-4 rounded-md border px-3 py-2 text-sm", mergeStatePanelClassName)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-current">{mergeState.label}</span>
                  <span className="rounded-full border border-current/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-current opacity-80">
                    GitHub state: {overview.mergeStateStatus}
                  </span>
                </div>
                <p className="mt-1 text-sm/6 text-current opacity-90">
                  {mergeState.description}
                </p>
                {overview.blockedReason && (
                  <p className="mt-2 text-xs uppercase tracking-[0.18em] text-current opacity-70">
                    Next step: {overview.blockedReason}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="grid items-stretch gap-4 px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
        <Card className="flex h-full flex-col overflow-hidden bg-surface">
          <SectionHeader title="Description" pipClassName="bg-muted-foreground/40" />
          <div className="flex-1 p-4">
            {bodyText ? (
              <>
                <div className={!showBody && hasLongBody ? "max-h-64 overflow-hidden" : ""}>
                  <MarkdownBody text={bodyText} className="text-muted-foreground" />
                </div>
                {hasLongBody && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 px-2"
                    onClick={() => setShowBody((prev) => !prev)}
                  >
                    {showBody ? "Show less" : "Show full description"}
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No PR description provided.</p>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden bg-surface">
          <SectionHeader
            title="Files Changed"
            detail={`${overview.changedFiles} total`}
            pipClassName="bg-nice-to-have"
          />
          <div className="p-2">
            {previewFiles.length > 0 ? (
              <div className="space-y-1">
                {previewFiles.map((file) => (
                  <div
                    key={file.path}
                    className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-muted"
                  >
                    <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/95">
                      {file.path}
                    </span>
                    <span className="shrink-0 text-[11px] text-emerald-400">+{file.additions}</span>
                    <span className="shrink-0 text-[11px] text-rose-400">-{file.deletions}</span>
                  </div>
                ))}

                {extraFiles.length > 0 && (
                  <div
                    className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
                    style={{
                      gridTemplateRows: showAllFiles ? "1fr" : "0fr",
                      opacity: showAllFiles ? 1 : 0.7,
                    }}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-1 pt-1">
                        {extraFiles.map((file) => (
                          <div
                            key={file.path}
                            className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-muted"
                          >
                            <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/95">
                              {file.path}
                            </span>
                            <span className="shrink-0 text-[11px] text-emerald-400">+{file.additions}</span>
                            <span className="shrink-0 text-[11px] text-rose-400">-{file.deletions}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="px-2.5 py-2 text-sm text-muted-foreground">No file list available.</div>
            )}

            {extraFiles.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                onClick={() => setShowAllFiles((prev) => !prev)}
              >
                {showAllFiles
                  ? "Show fewer files"
                  : `Show all ${overview.files.length} files`}
              </Button>
            )}
          </div>
        </Card>
      </div>

      <div className="px-6">
        <Card className="overflow-hidden bg-surface">
          <SectionHeader title="Review Confidence" pipClassName="bg-should-fix" />
          <div className="px-4 py-3">
            <ReviewScoreboard
              repo={repo}
              prNumber={prNumber}
              embedded
              title=""
              onRequestReview={onRequestReview}
              onRefreshReview={onRefreshReview}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
