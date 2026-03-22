import { useState } from "react";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { useAddRepo, useGitRemote } from "../hooks/useApi";
import { RepoDirectoryBrowser } from "./RepoDirectoryBrowser";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export function AddRepo() {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState("~");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const addRepo = useAddRepo();
  const { data: gitRemote, isLoading: isLoadingRemote, error: gitRemoteError } = useGitRemote(selectedPath);

  function resetDialog() {
    setOpen(false);
    setSelectedPath(null);
    setBrowsePath("~");
  }

  function handleConfirmBrowse() {
    if (!gitRemote || !selectedPath) return;
    addRepo.mutate(
      { owner: gitRemote.owner, repo: gitRemote.repo, localPath: selectedPath },
      { onSuccess: resetDialog },
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="group flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/8 px-3 py-2 text-left transition-all hover:border-primary/25 hover:bg-primary/5"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 transition-colors group-hover:border-primary/25 group-hover:bg-primary/10">
          <Plus className="h-3.5 w-3.5 text-primary" />
        </span>
        <span className="text-sm font-medium text-foreground">Add repository</span>
      </button>

      <Dialog
        open={open}
        onClose={resetDialog}
        title="Add repository"
        description="Choose a local checkout. PR Reviewer will read its Git remote and add the matching GitHub repository."
        contentClassName="max-w-2xl"
      >
        {selectedPath ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border/70 bg-muted/15 p-3">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background/80">
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Selected folder
                  </p>
                  <p className="mt-1 truncate text-sm text-foreground" title={selectedPath}>
                    {selectedPath}
                  </p>
                </div>
              </div>
            </div>

            {isLoadingRemote ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Inspecting the repository remote...
              </div>
            ) : gitRemote ? (
              <div className="rounded-xl border border-primary/20 bg-primary/10 px-3 py-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-primary/80">
                  Repository detected
                </p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {gitRemote.owner}/{gitRemote.repo}
                </p>
                <p className="mt-1 truncate text-[11px] text-muted-foreground" title={gitRemote.remoteUrl}>
                  {gitRemote.remoteUrl}
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3">
                <p className="text-sm text-destructive">
                  Could not read a GitHub remote from this directory.
                </p>
                {gitRemoteError ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Choose another checkout and try again.
                  </p>
                ) : null}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelectedPath(null)}>
                Choose another folder
              </Button>
              <Button
                size="sm"
                onClick={handleConfirmBrowse}
                disabled={!gitRemote || addRepo.isPending || isLoadingRemote}
              >
                {addRepo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                {gitRemote ? `Add ${gitRemote.owner}/${gitRemote.repo}` : "Add repository"}
              </Button>
            </div>
          </div>
        ) : (
          <RepoDirectoryBrowser
            path={browsePath}
            onPathChange={setBrowsePath}
            onSelect={setSelectedPath}
            onCancel={resetDialog}
            selectLabel="Inspect repo"
            requireGitRepo
            helperText="Navigate to a local checkout that contains a Git repository"
          />
        )}
      </Dialog>
    </>
  );
}
