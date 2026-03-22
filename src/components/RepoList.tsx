import { useRepos, useRemoveRepo, useUpdateRepo, useBrowse, useSyncRepo } from "../hooks/useApi";
import { Button } from "./ui/button";
import { Trash2, GitBranch, FolderOpen, Check, ChevronRight, ArrowUp, Home, RefreshCw, Loader2 } from "lucide-react";
import { useState } from "react";

function DirectoryPicker({
  initialPath,
  onSelect,
  onCancel,
  className,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [browsePath, setBrowsePath] = useState(initialPath || "~");
  const { data: browseData, isLoading } = useBrowse(browsePath);

  return (
    <div className={`border border-border rounded-xl overflow-hidden bg-background ${className ?? ""}`}>
      {/* Current path header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border">
        <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-xs font-mono text-muted-foreground truncate flex-1" title={browseData?.current}>
          {browseData?.current ?? browsePath}
        </span>
        {browseData?.isGitRepo && (
          <span className="text-[10px] font-medium text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded shrink-0">
            git repo
          </span>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => setBrowsePath("~")}
        >
          <Home className="h-3 w-3 mr-1" />
          Home
        </Button>
        {browseData?.parent && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={() => setBrowsePath(browseData.parent!)}
          >
            <ArrowUp className="h-3 w-3 mr-1" />
            Up
          </Button>
        )}
      </div>

      {/* Directory list */}
      <div className="max-h-48 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">Loading...</div>
        ) : browseData?.dirs.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">No subdirectories</div>
        ) : (
          browseData?.dirs.map((dir) => (
            <button
              key={dir}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 text-left"
              onClick={() => setBrowsePath(`${browseData.current}/${dir}`)}
            >
              <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate">{dir}</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
            </button>
          ))
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-border bg-muted/30">
        <span className="text-[10px] text-muted-foreground">
          {browseData?.isGitRepo ? "This is a git repository" : "Navigate to a git repository"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 text-xs px-2"
            onClick={() => onSelect(browseData?.current ?? browsePath)}
          >
            <Check className="h-3 w-3 mr-1" />
            Select
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RepoList() {
  const { data: repos } = useRepos();
  const removeRepo = useRemoveRepo();
  const updateRepo = useUpdateRepo();
  const syncRepo = useSyncRepo();
  const [browsingLabel, setBrowsingLabel] = useState<string | null>(null);
  const [deleteLabel, setDeleteLabel] = useState<string | null>(null);
  const [syncingLabel, setSyncingLabel] = useState<string | null>(null);

  if (!repos?.length) {
    return null;
  }

  return (
    <>
      <div className="contents">
        {repos.map((r) => (
          <div key={r.label} className="contents">
            <div
              className={`group min-h-[84px] rounded-xl border p-2.5 transition-all ${
                browsingLabel === r.label
                  ? "border-primary/30 bg-primary/10 shadow-[0_0_0_1px_rgba(109,91,247,0.18)]"
                  : "border-border bg-card hover:border-primary/15 hover:bg-muted/25"
              }`}
            >
              <div className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                        {r.owner}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium leading-tight text-foreground">
                      {r.repo}
                    </p>
                  </div>
                  {r.localPath && (
                    <span
                      className="mt-0.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-green-500/80"
                      title={r.localPath}
                    />
                  )}
                </div>

                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="truncate text-[10px] text-muted-foreground" title={r.label}>
                    {r.label}
                  </span>
                  <div className="ml-2 flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => {
                        setSyncingLabel(r.label);
                        syncRepo.mutate(r.label, {
                          onSettled: () => setSyncingLabel(null),
                        });
                      }}
                      disabled={syncingLabel === r.label}
                      title="Sync PRs & comments"
                    >
                      {syncingLabel === r.label ? (
                        <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setBrowsingLabel(browsingLabel === r.label ? null : r.label)}
                      title="Set local path"
                    >
                      <FolderOpen className="h-3 w-3 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setDeleteLabel(r.label)}
                      title="Remove repo"
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {browsingLabel === r.label && (
              <DirectoryPicker
                initialPath={r.localPath || "~"}
                className="col-span-3"
                onSelect={(selectedPath) => {
                  updateRepo.mutate({ label: r.label, localPath: selectedPath });
                  setBrowsingLabel(null);
                }}
                onCancel={() => setBrowsingLabel(null)}
              />
            )}
          </div>
        ))}
      </div>

      {deleteLabel !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setDeleteLabel(null)} />
          <div className="relative z-50 w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg">
            <h3 className="text-sm font-semibold">Remove repository</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Remove <span className="font-medium text-foreground">{deleteLabel}</span> from PR Reviewer?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDeleteLabel(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (deleteLabel) removeRepo.mutate({ label: deleteLabel });
                    setDeleteLabel(null);
                  }}
                >
                  Remove
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground text-right">
                Data is preserved. Re-adding the repo will restore it.{" "}
                <button
                  className="text-destructive hover:underline"
                  onClick={() => {
                    if (deleteLabel) removeRepo.mutate({ label: deleteLabel, hard: true });
                    setDeleteLabel(null);
                  }}
                >
                  Delete permanently
                </button>
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
