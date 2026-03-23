import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { useGitRemote } from "../hooks/useApi";
import { RepoDirectoryBrowser } from "./RepoDirectoryBrowser";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

function CloudAddRepo() {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState("~");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMachineSlug, setSelectedMachineSlug] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const workspaces = useQuery(api.workspaces.listForCurrentUser);
  const activeWorkspaceId = workspaces?.[0]?._id;
  const machines = useQuery(
    api.machines.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const upsertRepo = useMutation(api.repos.upsert);
  const upsertMachineConfig = useMutation(api.repos.upsertMachineConfig);
  const { data: gitRemote, isLoading: isLoadingRemote, error: gitRemoteError } = useGitRemote(selectedPath);

  useEffect(() => {
    if (!selectedMachineSlug && machines?.[0]?.slug) {
      setSelectedMachineSlug(machines[0].slug);
    }
  }, [machines, selectedMachineSlug]);

  function resetDialog() {
    setOpen(false);
    setSelectedPath(null);
    setBrowsePath("~");
    setSelectedMachineSlug(machines?.[0]?.slug ?? "");
  }

  async function handleRegisterCheckout() {
    if (!activeWorkspaceId || !selectedPath || !selectedMachineSlug || !gitRemote) {
      return;
    }

    setIsRegistering(true);

    try {
      const cloudRepo = await upsertRepo({
        workspaceId: activeWorkspaceId,
        owner: gitRemote.owner,
        repo: gitRemote.repo,
        botUsers: [],
      });

      if (!cloudRepo?._id) {
        throw new Error("Failed to create or load the repo in Convex.");
      }

      await upsertMachineConfig({
        workspaceId: activeWorkspaceId,
        repoId: cloudRepo._id,
        machineSlug: selectedMachineSlug,
        localPath: selectedPath,
        skipTypecheck: false,
      });

      resetDialog();
    } finally {
      setIsRegistering(false);
    }
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
        description="Choose a local checkout, confirm its GitHub remote, then bind it to one of your linked machines."
        contentClassName="max-w-2xl"
      >
        {!activeWorkspaceId ? (
          <div className="rounded-xl border border-border/70 bg-muted/15 px-4 py-4 text-sm text-muted-foreground">
            Your cloud workspace is still loading. Wait a moment and try again.
          </div>
        ) : !machines?.length ? (
          <div className="space-y-3 rounded-xl border border-border/70 bg-muted/15 px-4 py-4">
            <p className="text-sm text-foreground">No linked machines yet.</p>
            <p className="text-sm text-muted-foreground">
              Enroll a worker from the cloud control plane first. Repository onboarding is machine-bound in cloud mode.
            </p>
          </div>
        ) : selectedPath ? (
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
              <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/10 px-3 py-3">
                <div>
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

                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-primary/80">
                    Run On Machine
                  </p>
                  <Select value={selectedMachineSlug} onValueChange={setSelectedMachineSlug}>
                    <SelectTrigger className="h-9 rounded-md border border-border bg-background/70 px-3 text-sm text-foreground shadow-none focus:ring-2 focus:ring-ring">
                      <SelectValue placeholder="Select machine" />
                    </SelectTrigger>
                    <SelectContent>
                      {machines.map((machine) => (
                        <SelectItem key={machine._id} value={machine.slug}>
                          {machine.name} ({machine.status})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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
                onClick={() => void handleRegisterCheckout()}
                disabled={!gitRemote || !selectedMachineSlug || isLoadingRemote || isRegistering}
              >
                {isRegistering ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
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

export function AddRepo() {
  return <CloudAddRepo />;
}
