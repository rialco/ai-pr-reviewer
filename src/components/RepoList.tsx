import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, FolderOpen, GitBranch, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Popover } from "./ui/popover";

function machineStatusTone(status: string) {
  if (status === "busy") {
    return "bg-amber-400";
  }
  if (status === "error") {
    return "bg-destructive";
  }
  if (status === "offline") {
    return "bg-zinc-500";
  }
  return "bg-emerald-400";
}

function pickSyncTarget<T extends { machineStatus: string }>(configs: T[]) {
  return (
    configs.find((config) => config.machineStatus !== "offline" && config.machineStatus !== "busy") ??
    configs.find((config) => config.machineStatus !== "busy") ??
    null
  );
}

export function RepoList() {
  const { activeWorkspaceId } = useActiveWorkspace();
  const repos = useQuery(
    api.repos.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const repoMachineConfigs = useQuery(
    api.repos.listMachineConfigsForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const removeRepo = useMutation(api.repos.remove);
  const enqueueRepoSync = useMutation(api.jobs.enqueueRepoSync);
  const [deleteRepoId, setDeleteRepoId] = useState<Id<"repos"> | null>(null);
  const [syncingKey, setSyncingKey] = useState<string | null>(null);
  const [expandedRepoId, setExpandedRepoId] = useState<Id<"repos"> | null>(null);
  type RepoMachineConfig = NonNullable<typeof repoMachineConfigs>[number];

  const groupedRepos = useMemo(() => {
    const grouped = new Map<Id<"repos">, RepoMachineConfig[]>();

    for (const config of repoMachineConfigs ?? []) {
      const existing = grouped.get(config.repoId) ?? [];
      existing.push(config);
      grouped.set(config.repoId, existing);
    }

    return (repos ?? []).map((repo) => ({
      repo,
      configs: grouped.get(repo._id) ?? [],
    }));
  }, [repoMachineConfigs, repos]);

  if (!groupedRepos.length) {
    return null;
  }

  const repoPendingDelete = groupedRepos.find(({ repo }) => repo._id === deleteRepoId)?.repo;

  return (
    <>
      <div className="space-y-1.5">
        {groupedRepos.map(({ repo, configs }) => {
          const syncTarget = pickSyncTarget(configs);
          const syncKey = syncTarget ? `${syncTarget.repoId}:${syncTarget.machineSlug}` : null;
          const isSyncing = syncKey !== null && syncingKey === syncKey;

          return (
            <div key={repo._id} className="rounded-xl border border-border/70 bg-muted/10 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold leading-tight text-foreground">
                    {repo.label}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6.5 w-6.5 rounded-md"
                  disabled={!activeWorkspaceId || !syncTarget || isSyncing}
                  title={
                    syncTarget
                      ? `Queue repo sync on ${syncTarget.machineName}`
                      : "No available machine checkout to sync"
                  }
                  onClick={() => {
                    if (!activeWorkspaceId || !syncTarget || !syncKey) return;
                    setSyncingKey(syncKey);
                    void enqueueRepoSync({
                      workspaceId: activeWorkspaceId,
                      repoId: repo._id,
                      machineSlug: syncTarget.machineSlug,
                    }).finally(() => setSyncingKey(null));
                  }}
                >
                  {isSyncing ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  ) : (
                    <RefreshCw className="h-3 w-3 text-muted-foreground" />
                  )}
                </Button>
                <Popover
                  open={expandedRepoId === repo._id}
                  onOpenChange={(open) => setExpandedRepoId(open ? repo._id : null)}
                  align="right"
                  contentClassName="w-[20rem] max-w-[calc(100vw-1rem)]"
                  content={
                    <div className="space-y-3 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{repo.label}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {configs.length === 0
                              ? "No machine checkout registered yet."
                              : `${configs.length} machine checkout${configs.length === 1 ? "" : "s"}`}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6.5 w-6.5 rounded-md"
                          onClick={() => {
                            setExpandedRepoId(null);
                            setDeleteRepoId(repo._id);
                          }}
                          title="Archive repo from workspace"
                        >
                          <Trash2 className="h-3 w-3 text-muted-foreground" />
                        </Button>
                      </div>

                      {configs.length > 0 ? (
                        <div className="space-y-2">
                          {configs.map((config) => (
                            <div
                              key={config._id}
                              className="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5"
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className={`h-2 w-2 shrink-0 rounded-full ${machineStatusTone(config.machineStatus)}`}
                                  title={config.machineStatus}
                                />
                                <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                                  {config.machineName}
                                </p>
                                <span className="rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                                  {config.machineStatus}
                                </span>
                              </div>
                              <div className="mt-2 flex items-start gap-2 text-[11px] text-muted-foreground">
                                <FolderOpen className="mt-0.5 h-3 w-3 shrink-0" />
                                <span className="break-all leading-5">{config.localPath}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6.5 w-6.5 rounded-md"
                    aria-expanded={expandedRepoId === repo._id}
                    title="Show repository details"
                    onClick={() =>
                      setExpandedRepoId((current) => (current === repo._id ? null : repo._id))
                    }
                  >
                    <ChevronDown
                      className={`h-3 w-3 text-muted-foreground transition-transform duration-200 ${
                        expandedRepoId === repo._id ? "rotate-180" : ""
                      }`}
                    />
                  </Button>
                </Popover>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        open={deleteRepoId !== null}
        onClose={() => setDeleteRepoId(null)}
        title="Archive repository"
        description={
          repoPendingDelete
            ? `Archive ${repoPendingDelete.label} from this cloud workspace? Existing local checkouts remain on disk.`
            : ""
        }
        contentClassName="max-w-sm"
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setDeleteRepoId(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (!activeWorkspaceId || !deleteRepoId) return;
              void removeRepo({
                workspaceId: activeWorkspaceId,
                repoId: deleteRepoId,
              }).then(() => setDeleteRepoId(null));
            }}
          >
            Archive
          </Button>
        </div>
      </Dialog>
    </>
  );
}
