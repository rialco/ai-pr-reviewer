import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Cloud, Copy, KeyRound, ServerCog, ShieldPlus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Popover } from "./ui/popover";
import { CodeBlock } from "./CodeBlock";

interface CloudControlDockProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CloudControlDock({ open, onOpenChange }: CloudControlDockProps) {
  const viewer = useQuery(api.bootstrap.viewer);
  const workspaces = useQuery(api.workspaces.listForCurrentUser);
  const activeWorkspaceId = workspaces?.[0]?._id;
  const machines = useQuery(
    api.machines.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const jobs = useQuery(
    api.jobs.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const jobRuns = useQuery(
    api.jobs.listRunsForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const enrollmentTokens = useQuery(
    api.machines.listEnrollmentTokensForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const createEnrollmentToken = useMutation(api.machines.createEnrollmentToken);
  const revokeEnrollmentToken = useMutation(api.machines.revokeEnrollmentToken);
  const enqueueMachineSelfCheck = useMutation(api.jobs.enqueueMachineSelfCheck);
  const [copied, setCopied] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!viewer || !viewer.user) {
    return null;
  }

  type JobRunRecord = NonNullable<typeof jobRuns>[number];
  const latestToken = enrollmentTokens?.[0];
  const recentMachineJobs = (jobs ?? [])
    .filter((job) => job.kind === "machine_command" || job.kind === "sync_repo")
    .slice(0, 4);
  const recentMachineRunsByJobId = (jobRuns ?? []).reduce((runsByJobId, run) => {
    if (!runsByJobId.has(run.jobId)) {
      runsByJobId.set(run.jobId, run);
    }
    return runsByJobId;
  }, new Map<string, JobRunRecord>());
  const workerSnippet = latestToken
    ? [`WORKER_ENROLLMENT_TOKEN=${latestToken.token}`, "pnpm dev:worker"].join(" \\\n  ")
    : null;

  const handleCreateToken = async () => {
    if (!activeWorkspaceId) return;
    await createEnrollmentToken({
      workspaceId: activeWorkspaceId,
      ttlMinutes: 30,
      label: "Local worker enrollment",
    });
  };

  const handleCopySnippet = async () => {
    if (!workerSnippet) return;
    await navigator.clipboard.writeText(workerSnippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleEnqueueSelfCheck = async (machineSlug: string) => {
    if (!activeWorkspaceId) return;
    await enqueueMachineSelfCheck({
      workspaceId: activeWorkspaceId,
      machineSlug,
    });
  };

  const displayName = viewer.user.name ?? viewer.user.email ?? viewer.identity.subject;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        className="min-w-0"
        contentContainerClassName="fixed bottom-1 left-[calc(340px+8px)]"
        contentClassName="w-[24rem] max-w-[calc(100vw-1rem)]"
        content={
          <div className="space-y-3 p-3">
            <div className="rounded-lg border border-border/60 bg-background/20 px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Signed In As
              </p>
              <p className="mt-1 truncate text-sm font-medium text-foreground">{displayName}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/60 bg-background/20 p-3">
                <div className="mb-1 flex items-center gap-2 text-foreground/80">
                  <Users className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Workspaces</span>
                </div>
                <p className="text-lg font-semibold text-foreground">{workspaces?.length ?? 0}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/20 p-3">
                <div className="mb-1 flex items-center gap-2 text-foreground/80">
                  <Cloud className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Machines</span>
                </div>
                <p className="text-lg font-semibold text-foreground">{machines?.length ?? 0}</p>
              </div>
            </div>

            <div className="flex justify-end border-t border-border/60 pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  setAdvancedOpen(true);
                }}
              >
                See advanced settings
              </Button>
            </div>
          </div>
        }
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className={`flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors ${
            open ? "border-primary/30 bg-primary/10" : "border-border bg-card/80 hover:bg-muted/20"
          }`}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <ServerCog className="h-3.5 w-3.5" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cloud</p>
            <p className="truncate text-xs font-medium text-foreground/95">{displayName}</p>
            <p className="truncate text-[10px] text-muted-foreground">
              {workspaces?.length ?? 0} workspace{(workspaces?.length ?? 0) === 1 ? "" : "s"} • {machines?.length ?? 0} machine{(machines?.length ?? 0) === 1 ? "" : "s"}
            </p>
          </div>

          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </Popover>

      <Dialog
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        title="Cloud Control Plane"
        description="Machine enrollment, worker commands, and recent machine-scoped jobs for the current workspace."
        contentClassName="max-w-3xl"
      >
        <div className="space-y-4 text-sm text-muted-foreground">
          <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">Signed In As</p>
            <p className="mt-1 truncate text-sm text-foreground">{displayName}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border/70 bg-background/50 p-3">
              <div className="mb-1 flex items-center gap-2 text-foreground/80">
                <Users className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Workspaces</span>
              </div>
              <p className="text-lg font-semibold text-foreground">{workspaces?.length ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-background/50 p-3">
              <div className="mb-1 flex items-center gap-2 text-foreground/80">
                <Cloud className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Machines</span>
              </div>
              <p className="text-lg font-semibold text-foreground">{machines?.length ?? 0}</p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">Linked Machines</p>
              <p className="mt-1 text-xs leading-5">
                Use a self-check job to verify the claim, execute, and completion loop from the cloud control plane.
              </p>
            </div>

            {machines && machines.length > 0 ? (
              <div className="space-y-2">
                {machines.map((machine) => (
                  <div key={machine._id} className="rounded-md border border-border/70 bg-card/80 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{machine.name}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {machine.slug} · {machine.status} · {machine.platform ?? "unknown platform"}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Last heartbeat {new Date(machine.lastHeartbeatAt).toLocaleString()}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={machine.status === "busy"}
                        onClick={() => void handleEnqueueSelfCheck(machine.slug)}
                      >
                        Self-check
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No linked machines yet. Enroll a worker first, then queue a self-check here.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                  <ShieldPlus className="h-3.5 w-3.5" />
                  Machine Enrollment
                </p>
                <p className="mt-1 text-xs leading-5">
                  Mint a 30-minute token for a local worker. The token is one-time use and becomes a persistent machine credential after registration.
                </p>
              </div>
              <Button size="sm" onClick={() => void handleCreateToken()} disabled={!activeWorkspaceId}>
                <KeyRound className="h-3.5 w-3.5" />
                Token
              </Button>
            </div>

            {latestToken ? (
              <div className="space-y-2">
                <div className="rounded-md border border-border/70 bg-card/80 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">Active Token</p>
                  <p className="mt-1 break-all font-mono text-xs text-primary">{latestToken.token}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Expires at {new Date(latestToken.expiresAt).toLocaleString()}
                  </p>
                </div>

                {workerSnippet ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">Worker Command</p>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" onClick={() => void handleCopySnippet()}>
                          <Copy className="h-3.5 w-3.5" />
                          {copied ? "Copied" : "Copy"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void revokeEnrollmentToken({
                              workspaceId: activeWorkspaceId!,
                              tokenId: latestToken._id,
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      </div>
                    </div>
                    <CodeBlock code={workerSnippet} lang="bash" />
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No active enrollment token yet. Create one when you are ready to attach a worker.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">Recent Machine Jobs</p>
              <p className="mt-1 text-xs leading-5">Latest machine-scoped jobs from this workspace.</p>
            </div>

            {recentMachineJobs.length > 0 ? (
              <div className="space-y-2">
                {recentMachineJobs.map((job) => {
                  const latestRun = recentMachineRunsByJobId.get(job._id);

                  return (
                    <div key={job._id} className="rounded-md border border-border/70 bg-card/80 px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{job.title}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {job.targetMachineSlug ?? "any machine"} · {job.status} · {new Date(job.updatedAt).toLocaleString()}
                          </p>
                          {job.errorMessage ? <p className="mt-1 text-[11px] text-destructive">{job.errorMessage}</p> : null}
                          {latestRun ? (
                            <div className="mt-2 space-y-1 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Latest Run</p>
                              <p className="text-[11px] text-muted-foreground">
                                {latestRun.status} · {latestRun.machineSlug ?? "unassigned"}
                              </p>
                              {latestRun.steps.slice(-2).map((step, index) => (
                                <p key={`${job._id}-${index}`} className="text-[11px] text-muted-foreground">
                                  {step.step}: {step.detail ?? step.status}
                                </p>
                              ))}
                              {latestRun.output.slice(-3).map((line, index) => (
                                <p key={`${job._id}-line-${index}`} className="font-mono text-[10px] text-foreground/80">
                                  {line}
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No machine jobs yet. Queue a self-check on any linked machine to validate the loop.
              </p>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
