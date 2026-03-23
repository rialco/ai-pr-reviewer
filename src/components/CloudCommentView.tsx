import { useQuery } from "convex/react";
import { AlertCircle, ExternalLink, FileCode, GitBranch, GitCommitHorizontal, Github, Loader2, MessageSquare, Minus, Plus, RefreshCw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { MarkdownBody } from "./MarkdownBody";

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

export function CloudCommentView({ repo, prNumber }: CloudCommentViewProps) {
  const { activeWorkspaceId } = useActiveWorkspace();
  const detail = useQuery(
    api.prs.getDetailForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, repoLabel: repo, prNumber } : "skip",
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

            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
              <Button variant="outline" size="sm">
                <ExternalLink className="h-3.5 w-3.5" />
                Open on GitHub
              </Button>
            </a>
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
                  Refresh by syncing this repo on a linked machine
                </span>
              </div>

              {comments.length === 0 ? (
                <div className="mt-3 rounded-xl border border-dashed border-white/10 px-4 py-6 text-sm text-muted-foreground">
                  No synced GitHub comments for this PR yet.
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {comments.map((comment) => (
                    <Card key={comment._id} className="border-white/8 bg-zinc-900/55 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <CommentTypeBadge type={comment.type} />
                        <Badge variant="outline">{comment.user}</Badge>
                        {comment.path ? <Badge variant="outline">{comment.path}{comment.line ? `:${comment.line}` : ""}</Badge> : null}
                        <span className="text-xs text-muted-foreground">{formatTimestamp(comment.updatedAt)}</span>
                      </div>
                      <div className="mt-3 text-sm leading-6 text-foreground/88">
                        <MarkdownBody text={comment.body} />
                      </div>
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

            <Card className="border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 text-amber-300" />
                <div className="text-sm text-amber-100/90">
                  GitHub PR detail and comments are cloud-backed now. Analysis, fixes, replies, and local review comments are still on the remaining migration path.
                </div>
              </div>
            </Card>
          </div>
        </div>
      </Card>
    </div>
  );
}
