import { SignInButton, UserButton } from "@clerk/react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { Cloud, Copy, KeyRound, LaptopMinimalCheck, ShieldCheck, ShieldPlus, ServerCog, Trash2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App } from "@/App";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { hasCloudEnv, missingCloudEnv } from "@/lib/cloud";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CodeBlock } from "@/components/CodeBlock";

function CloudBootstrap() {
  const ensureCurrentUser = useMutation(api.bootstrap.ensureCurrentUser);
  const hasBootstrappedRef = useRef(false);

  useEffect(() => {
    if (hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;
    void ensureCurrentUser();
  }, [ensureCurrentUser]);

  return null;
}

function CloudStatusCard() {
  const viewer = useQuery(api.bootstrap.viewer);
  const workspaces = useQuery(api.workspaces.listForCurrentUser);
  const activeWorkspaceId = workspaces?.[0]?._id;
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [checkoutOwner, setCheckoutOwner] = useState("");
  const [checkoutRepo, setCheckoutRepo] = useState("");
  const [checkoutPath, setCheckoutPath] = useState("");
  const [selectedMachineSlug, setSelectedMachineSlug] = useState("");
  const createEnrollmentToken = useMutation(api.machines.createEnrollmentToken);
  const revokeEnrollmentToken = useMutation(api.machines.revokeEnrollmentToken);
  const enqueueMachineSelfCheck = useMutation(api.jobs.enqueueMachineSelfCheck);
  const enqueueRepoSync = useMutation(api.jobs.enqueueRepoSync);
  const upsertRepo = useMutation(api.repos.upsert);
  const upsertMachineConfig = useMutation(api.repos.upsertMachineConfig);
  const machines = useQuery(
    api.machines.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const repos = useQuery(
    api.repos.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const repoMachineConfigs = useQuery(
    api.repos.listMachineConfigsForWorkspace,
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

  useEffect(() => {
    if (!selectedMachineSlug && machines?.[0]?.slug) {
      setSelectedMachineSlug(machines[0].slug);
    }
  }, [machines, selectedMachineSlug]);

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
  }, new Map<Id<"jobs">, JobRunRecord>());
  const workerSnippet = latestToken
    ? [
        `WORKER_ENROLLMENT_TOKEN=${latestToken.token}`,
        "pnpm dev:worker",
      ].join(" \\\n  ")
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

  const handleRegisterCheckout = async () => {
    if (!activeWorkspaceId || !selectedMachineSlug) return;
    const owner = checkoutOwner.trim();
    const repo = checkoutRepo.trim();
    const localPath = checkoutPath.trim();

    if (!owner || !repo || !localPath) {
      return;
    }

    const cloudRepo = await upsertRepo({
      workspaceId: activeWorkspaceId,
      owner,
      repo,
      botUsers: [],
    });

    if (!cloudRepo?._id) {
      throw new Error("Failed to create or load the repo in Convex.");
    }

    await upsertMachineConfig({
      workspaceId: activeWorkspaceId,
      repoId: cloudRepo._id,
      machineSlug: selectedMachineSlug,
      localPath,
      skipTypecheck: false,
    });

    setCheckoutOwner("");
    setCheckoutRepo("");
    setCheckoutPath("");
  };

  const handleEnqueueRepoSync = async (repoId: Id<"repos">, machineSlug: string) => {
    if (!activeWorkspaceId) return;
    await enqueueRepoSync({
      workspaceId: activeWorkspaceId,
      repoId,
      machineSlug,
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="right"
      className="min-w-0"
      contentContainerClassName="absolute right-0 top-full mt-2"
      contentClassName="w-[24rem] max-w-[calc(100vw-1.5rem)]"
      content={
        <div className="space-y-3 p-4 text-sm text-muted-foreground">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ServerCog className="h-4 w-4 text-primary" />
                Cloud Control Plane
              </p>
              <p className="mt-1 text-xs leading-5">
                Convex is linked and Clerk-authenticated. Machines enroll locally, then heartbeat
                back to this workspace.
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>

          <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
              Signed In As
            </p>
            <p className="mt-1 truncate text-sm text-foreground">
              {viewer.user.name ?? viewer.user.email ?? viewer.identity.subject}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border/70 bg-background/50 p-3">
              <div className="mb-1 flex items-center gap-2 text-foreground/80">
                <Users className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                  Workspaces
                </span>
              </div>
              <p className="text-lg font-semibold text-foreground">{workspaces?.length ?? 0}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-background/50 p-3">
              <div className="mb-1 flex items-center gap-2 text-foreground/80">
                <Cloud className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                  Machines
                </span>
              </div>
              <p className="text-lg font-semibold text-foreground">{machines?.length ?? 0}</p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                Register Checkout
              </p>
              <p className="mt-1 text-xs leading-5">
                Attach a repo checkout path to a linked machine so the cloud queue can target real
                local work.
              </p>
            </div>

            <div className="grid gap-2">
              <input
                value={checkoutOwner}
                onChange={(event) => setCheckoutOwner(event.target.value)}
                placeholder="GitHub owner"
                className="h-9 rounded-md border border-border bg-transparent px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={checkoutRepo}
                onChange={(event) => setCheckoutRepo(event.target.value)}
                placeholder="Repository name"
                className="h-9 rounded-md border border-border bg-transparent px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={checkoutPath}
                onChange={(event) => setCheckoutPath(event.target.value)}
                placeholder="/absolute/path/to/local/checkout"
                className="h-9 rounded-md border border-border bg-transparent px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
              <Select value={selectedMachineSlug} onValueChange={setSelectedMachineSlug}>
                <SelectTrigger className="h-9 rounded-md border border-border bg-transparent px-3 text-sm text-foreground shadow-none focus:ring-2 focus:ring-ring">
                  <SelectValue placeholder="Select machine" />
                </SelectTrigger>
                <SelectContent>
                  {(machines ?? []).map((machine) => (
                    <SelectItem key={machine._id} value={machine.slug}>
                      {machine.name} ({machine.slug})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void handleRegisterCheckout()}
                disabled={!activeWorkspaceId || !selectedMachineSlug || !checkoutOwner || !checkoutRepo || !checkoutPath}
              >
                Save Checkout
              </Button>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                Repo Checkouts
              </p>
              <p className="mt-1 text-xs leading-5">
                Registered cloud repos: {repos?.length ?? 0}. Machine-bound checkout configs can
                run sync jobs without the local SQLite backend.
              </p>
            </div>

            {repoMachineConfigs && repoMachineConfigs.length > 0 ? (
              <div className="space-y-2">
                {repoMachineConfigs.map((config) => (
                  <div key={config._id} className="rounded-md border border-border/70 bg-card/80 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{config.repoLabel}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {config.machineName} · {config.machineSlug} · {config.machineStatus}
                        </p>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {config.localPath}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={config.machineStatus === "busy"}
                        onClick={() => void handleEnqueueRepoSync(config.repoId, config.machineSlug)}
                      >
                        Sync
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No machine checkout configs yet. Save one above, then queue a cloud repo sync.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                  Linked Machines
                </p>
                <p className="mt-1 text-xs leading-5">
                  Use a self-check job to verify the claim, execute, and completion loop from the
                  cloud control plane.
                </p>
              </div>
            </div>

            {machines && machines.length > 0 ? (
              <div className="space-y-2">
                {machines.map((machine) => (
                  <div
                    key={machine._id}
                    className="rounded-md border border-border/70 bg-card/80 px-3 py-2"
                  >
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
                  Mint a 30-minute token for a local worker. The token is one-time use and becomes
                  a persistent machine credential after registration.
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
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                    Active Token
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-primary">{latestToken.token}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Expires at {new Date(latestToken.expiresAt).toLocaleString()}
                  </p>
                </div>

                {workerSnippet ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                        Worker Command
                      </p>
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
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/80">
                Recent Machine Jobs
              </p>
              <p className="mt-1 text-xs leading-5">
                Latest machine-scoped jobs from this workspace.
              </p>
            </div>

            {recentMachineJobs.length > 0 ? (
              <div className="space-y-2">
                {recentMachineJobs.map((job) => (
                  <div key={job._id} className="rounded-md border border-border/70 bg-card/80 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{job.title}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {job.targetMachineSlug ?? "any machine"} · {job.status} ·{" "}
                          {new Date(job.updatedAt).toLocaleString()}
                        </p>
                        {job.errorMessage ? (
                          <p className="mt-1 text-[11px] text-destructive">{job.errorMessage}</p>
                        ) : null}
                        {recentMachineRunsByJobId.get(job._id) ? (
                          <div className="mt-2 space-y-1 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                              Latest Run
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {recentMachineRunsByJobId.get(job._id)?.status} ·{" "}
                              {recentMachineRunsByJobId.get(job._id)?.machineSlug ?? "unassigned"}
                            </p>
                            {(recentMachineRunsByJobId.get(job._id)?.steps ?? []).slice(-2).map((step, index) => (
                              <p key={`${job._id}-${index}`} className="text-[11px] text-muted-foreground">
                                {step.step}: {step.detail ?? step.status}
                              </p>
                            ))}
                            {(recentMachineRunsByJobId.get(job._id)?.output ?? []).slice(-3).map((line, index) => (
                              <p key={`${job._id}-line-${index}`} className="font-mono text-[10px] text-foreground/80">
                                {line}
                              </p>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No machine jobs yet. Queue a self-check on any linked machine to validate the loop.
              </p>
            )}
          </div>
        </div>
      }
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex min-w-0 items-center gap-3 rounded-full border px-3 py-2 text-left shadow-lg backdrop-blur transition-colors ${
          open
            ? "border-primary/35 bg-card/95"
            : "border-border/80 bg-card/88 hover:bg-card"
        }`}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
          <ServerCog className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Cloud
          </p>
          <p className="truncate text-sm font-medium text-foreground">
            {machines?.length ?? 0} machines in {workspaces?.length ?? 0} workspace
            {(workspaces?.length ?? 0) === 1 ? "" : "s"}
          </p>
        </div>
      </button>
    </Popover>
  );
}

function SignedInApp() {
  return (
    <div className="relative h-screen">
      <CloudBootstrap />
      <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-end px-3">
        <div className="pointer-events-auto flex items-start gap-2">
          <CloudStatusCard />
          <div className="rounded-full border border-border bg-card/90 p-1 shadow-lg backdrop-blur">
            <UserButton />
          </div>
        </div>
      </div>
      <App />
    </div>
  );
}

function LegacyLocalMode() {
  return (
    <div className="relative h-screen">
      <div className="pointer-events-none absolute bottom-4 right-4 z-50 max-w-sm">
        <Card className="pointer-events-auto border-primary/20 bg-card/95 shadow-2xl backdrop-blur">
          <CardHeader>
            <div className="flex items-center gap-2 text-primary">
              <LaptopMinimalCheck className="h-4 w-4" />
              <CardTitle>Legacy Local Mode</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Cloud auth is not configured yet, so the existing local backend stays active in this
              branch while Clerk and Convex are wired in.
            </p>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-foreground/80">
                Missing Env
              </p>
              <p>{missingCloudEnv.join(", ")}</p>
            </div>
          </CardContent>
        </Card>
      </div>
      <App />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md border-border/80 bg-card/90 shadow-2xl">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary">
            <Cloud className="h-4 w-4" />
            <CardTitle>Connecting Cloud Control Plane</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Loading your Clerk session and Convex subscriptions.
        </CardContent>
      </Card>
    </div>
  );
}

function SignInScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-xl border-border/80 bg-card shadow-2xl">
        <CardHeader className="space-y-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <CardTitle className="text-lg">Sign In To The Cloud Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-6 text-muted-foreground">
            The control plane moves to Clerk and Convex, but execution stays on your linked
            machines. Sign in here to access repo state, PR status, jobs, and machine availability
            from anywhere.
          </p>
          <div className="flex flex-wrap gap-3">
            <SignInButton mode="modal">
              <Button size="lg">Continue With Clerk</Button>
            </SignInButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CloudAppShell() {
  if (!hasCloudEnv) {
    return <LegacyLocalMode />;
  }

  return (
    <>
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
      <Unauthenticated>
        <SignInScreen />
      </Unauthenticated>
      <Authenticated>
        <SignedInApp />
      </Authenticated>
    </>
  );
}
