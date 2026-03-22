import { useState } from "react";
import { usePROverview } from "../hooks/useApi";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SectionHeader } from "./ui/section-header";
import { MarkdownBody } from "./MarkdownBody";
import { ReviewScoreboard } from "./ReviewScoreboard";
import {
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

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden bg-surface">
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge variant="outline">#{overview.number}</Badge>
                <Badge variant="outline">{overview.author}</Badge>
                {coordinatorIgnored && (
                  <Badge variant="outline" className="border-amber-500/30 text-amber-400">
                    Coordinator ignored
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  Updated {new Date(overview.updatedAt).toLocaleString()}
                </span>
              </div>
              <h1 className="text-xl font-semibold leading-tight text-foreground/85">{overview.title}</h1>
              <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted-foreground/90">
                <span className="inline-flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5" />
                  {overview.baseRefName} ← {overview.headRefName}
                </span>
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
        </div>
      </Card>

      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
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
  );
}
