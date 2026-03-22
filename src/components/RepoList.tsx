import { useState } from "react";
import { FolderOpen, GitBranch, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useRemoveRepo, useRepos, useSyncRepo, useUpdateRepo } from "../hooks/useApi";
import { RepoDirectoryBrowser } from "./RepoDirectoryBrowser";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export function RepoList() {
  const { data: repos } = useRepos();
  const removeRepo = useRemoveRepo();
  const updateRepo = useUpdateRepo();
  const syncRepo = useSyncRepo();
  const [browsingLabel, setBrowsingLabel] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState("~");
  const [deleteLabel, setDeleteLabel] = useState<string | null>(null);
  const [syncingLabel, setSyncingLabel] = useState<string | null>(null);

  if (!repos?.length) {
    return null;
  }

  return (
    <>
      <div className="space-y-2">
        {repos.map((repo) => {
          const isBrowsing = browsingLabel === repo.label;
          const isSyncing = syncingLabel === repo.label;

          return (
            <div key={repo.label} className="space-y-2">
              <div
                className={`group rounded-xl border px-2.5 py-2.5 transition-all ${
                  isBrowsing
                    ? "border-primary/30 bg-primary/10 shadow-[0_0_0_1px_rgba(109,91,247,0.18)]"
                    : "border-border/70 bg-muted/10 hover:border-primary/15 hover:bg-muted/20"
                }`}
              >
                <div className="flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold leading-tight text-foreground">
                        {repo.label}
                      </p>
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${repo.localPath ? "bg-green-400" : "bg-muted-foreground/60"}`}
                        title={repo.localPath ?? "No local path"}
                      />
                    </div>
                    <p
                      className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground"
                      title={repo.localPath ?? "No local path"}
                    >
                      {repo.localPath ?? "No local path"}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5 pl-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6.5 w-6.5 rounded-md"
                      onClick={() => {
                        setSyncingLabel(repo.label);
                        syncRepo.mutate(repo.label, {
                          onSettled: () => setSyncingLabel(null),
                        });
                      }}
                      disabled={isSyncing}
                      title="Sync PRs & comments"
                    >
                      {isSyncing ? (
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                      ) : (
                        <RefreshCw className="h-3 w-3 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-6.5 w-6.5 rounded-md ${isBrowsing ? "bg-primary/10 hover:bg-primary/15" : ""}`}
                      onClick={() => {
                        if (isBrowsing) {
                          setBrowsingLabel(null);
                          return;
                        }
                        setBrowsePath(repo.localPath || "~");
                        setBrowsingLabel(repo.label);
                      }}
                      title="Set local path"
                    >
                      <FolderOpen className={`h-3 w-3 ${isBrowsing ? "text-primary" : "text-muted-foreground"}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6.5 w-6.5 rounded-md"
                      onClick={() => setDeleteLabel(repo.label)}
                      title="Remove repo"
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </div>

              {isBrowsing ? (
                <RepoDirectoryBrowser
                  path={browsePath}
                  onPathChange={setBrowsePath}
                  onSelect={(selectedPath) => {
                    updateRepo.mutate({ label: repo.label, localPath: selectedPath });
                    setBrowsingLabel(null);
                  }}
                  onCancel={() => setBrowsingLabel(null)}
                  className="animate-enter-fade-slide"
                  selectLabel="Use this folder"
                  requireGitRepo
                  helperText="Navigate to the local checkout for this repository"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <Dialog
        open={deleteLabel !== null}
        onClose={() => setDeleteLabel(null)}
        title="Remove repository"
        description={
          deleteLabel
            ? `Remove ${deleteLabel} from PR Reviewer? Data is preserved, and re-adding it will restore it.`
            : ""
        }
        contentClassName="max-w-sm"
      >
        <div className="space-y-3">
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
          <p className="text-right text-[11px] text-muted-foreground">
            Need a full cleanup?{" "}
            <button
              type="button"
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
      </Dialog>
    </>
  );
}
