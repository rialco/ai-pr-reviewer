import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

function CloudAddRepo() {
  const [open, setOpen] = useState(false);
  const [requestedPath, setRequestedPath] = useState("");
  const [selectedMachineSlug, setSelectedMachineSlug] = useState("");
  const [activeProbeId, setActiveProbeId] = useState<Id<"checkoutProbes"> | null>(null);
  const [isSubmittingProbe, setIsSubmittingProbe] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const workspaces = useQuery(api.workspaces.listForCurrentUser);
  const activeWorkspaceId = workspaces?.[0]?._id;
  const machines = useQuery(
    api.machines.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const upsertRepo = useMutation(api.repos.upsert);
  const upsertMachineConfig = useMutation(api.repos.upsertMachineConfig);
  const requestCheckoutProbe = useMutation(api.repos.requestCheckoutProbe);
  const checkoutProbe = useQuery(
    api.repos.getCheckoutProbe,
    activeWorkspaceId && activeProbeId
      ? { workspaceId: activeWorkspaceId, probeId: activeProbeId }
      : "skip",
  );

  useEffect(() => {
    if (!selectedMachineSlug && machines?.[0]?.slug) {
      setSelectedMachineSlug(machines[0].slug);
    }
  }, [machines, selectedMachineSlug]);

  function resetDialog() {
    setOpen(false);
    setRequestedPath("");
    setActiveProbeId(null);
    setSelectedMachineSlug(machines?.[0]?.slug ?? "");
  }

  async function handleInspectCheckout() {
    if (!activeWorkspaceId || !selectedMachineSlug || !requestedPath.trim()) {
      return;
    }

    setIsSubmittingProbe(true);
    try {
      const probe = await requestCheckoutProbe({
        workspaceId: activeWorkspaceId,
        machineSlug: selectedMachineSlug,
        requestedPath: requestedPath.trim(),
      });

      if (probe?._id) {
        setActiveProbeId(probe._id);
      }
    } finally {
      setIsSubmittingProbe(false);
    }
  }

  async function handleRegisterCheckout() {
    if (
      !activeWorkspaceId ||
      !selectedMachineSlug ||
      !checkoutProbe ||
      checkoutProbe.status !== "ready" ||
      !checkoutProbe.normalizedPath ||
      !checkoutProbe.owner ||
      !checkoutProbe.repo
    ) {
      return;
    }

    setIsRegistering(true);

    try {
      const cloudRepo = await upsertRepo({
        workspaceId: activeWorkspaceId,
        owner: checkoutProbe.owner,
        repo: checkoutProbe.repo,
        botUsers: [],
      });

      if (!cloudRepo?._id) {
        throw new Error("Failed to create or load the repo in Convex.");
      }

      await upsertMachineConfig({
        workspaceId: activeWorkspaceId,
        repoId: cloudRepo._id,
        machineSlug: selectedMachineSlug,
        localPath: checkoutProbe.normalizedPath,
        skipTypecheck: false,
      });

      resetDialog();
    } finally {
      setIsRegistering(false);
    }
  }

  const isInspecting =
    isSubmittingProbe ||
    checkoutProbe?.status === "queued" ||
    checkoutProbe?.status === "running";
  const probeReady = checkoutProbe?.status === "ready";
  const probeError = checkoutProbe?.status === "error" ? checkoutProbe.errorMessage : null;

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
        description="Enter a local checkout path and let the selected worker inspect it. Once the GitHub remote is detected, bind that checkout to the machine."
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
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Local Checkout Path
              </p>
              <div className="rounded-xl border border-border/70 bg-muted/15 p-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background/80">
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <input
                      value={requestedPath}
                      onChange={(event) => {
                        setRequestedPath(event.target.value);
                        setActiveProbeId(null);
                      }}
                      placeholder="~/code/my-repo"
                      className="w-full border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      The worker will validate this path locally and inspect `git remote get-url origin`.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Run On Machine
              </p>
              <Select
                value={selectedMachineSlug}
                onValueChange={(value) => {
                  setSelectedMachineSlug(value);
                  setActiveProbeId(null);
                }}
              >
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

            {isInspecting ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Inspecting the checkout on {selectedMachineSlug || "the selected machine"}...
              </div>
            ) : probeReady ? (
              <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/10 px-3 py-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-primary/80">
                    Repository detected
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {checkoutProbe.owner}/{checkoutProbe.repo}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground" title={checkoutProbe.remoteUrl}>
                    {checkoutProbe.remoteUrl}
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Local path: {checkoutProbe.normalizedPath}
                  </p>
                </div>
              </div>
            ) : probeError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3">
                <p className="text-sm text-destructive">{probeError}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Correct the path or switch machines, then inspect again.
                </p>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={resetDialog}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleInspectCheckout()}
                disabled={!requestedPath.trim() || !selectedMachineSlug || isInspecting}
              >
                {isInspecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                Inspect checkout
              </Button>
              <Button size="sm" onClick={() => void handleRegisterCheckout()} disabled={!probeReady || isRegistering}>
                {isRegistering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                {probeReady ? `Add ${checkoutProbe.owner}/${checkoutProbe.repo}` : "Add repository"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

export function AddRepo() {
  return <CloudAddRepo />;
}
