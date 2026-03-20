import { useRepos, useRemoveRepo, useUpdateRepo, useBrowse, useSyncRepo } from "../hooks/useApi";
import { Button } from "./ui/button";
import { Trash2, GitBranch, FolderOpen, Check, ChevronRight, ArrowUp, Home, RefreshCw, Loader2 } from "lucide-react";
import { useState } from "react";

function DirectoryPicker({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [browsePath, setBrowsePath] = useState(initialPath || "~");
  const { data: browseData, isLoading } = useBrowse(browsePath);

  return (
    <div className="mt-1.5 ml-5.5 border border-border rounded-md overflow-hidden bg-background">
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
    return (
      <p className="text-sm text-muted-foreground py-3">
        No repos configured. Add one above.
      </p>
    );
  }

  return (
    <>
      <ul className="space-y-1.5">
        {repos.map((r) => (
          <li key={r.label} className="rounded-md px-3 py-2 hover:bg-accent/50 group">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                {r.label}
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 h-7 w-7"
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
                  className="opacity-0 group-hover:opacity-100 h-7 w-7"
                  onClick={() => setBrowsingLabel(browsingLabel === r.label ? null : r.label)}
                  title="Set local path"
                >
                  <FolderOpen className="h-3 w-3 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 h-7 w-7"
                  onClick={() => setDeleteLabel(r.label)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>
            {r.localPath && browsingLabel !== r.label && (
              <div className="flex items-center gap-1.5 mt-1 ml-5.5">
                <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground truncate" title={r.localPath}>
                  {r.localPath}
                </span>
              </div>
            )}
            {browsingLabel === r.label && (
              <DirectoryPicker
                initialPath={r.localPath || "~"}
                onSelect={(selectedPath) => {
                  updateRepo.mutate({ label: r.label, localPath: selectedPath });
                  setBrowsingLabel(null);
                }}
                onCancel={() => setBrowsingLabel(null)}
              />
            )}
          </li>
        ))}
      </ul>

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
