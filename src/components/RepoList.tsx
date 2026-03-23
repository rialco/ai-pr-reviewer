import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FolderOpen, GitBranch, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

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
        {groupedRepos.map(({ repo, configs }) => (
          <div key={repo._id} className="rounded-xl border border-border/70 bg-muted/10 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold leading-tight text-foreground">
                    {repo.label}
                  </p>
                  {configs.length > 1 ? (
                    <span className="rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {configs.length} checkout{configs.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6.5 w-6.5 rounded-md"
                onClick={() => setDeleteRepoId(repo._id)}
                title="Archive repo from workspace"
              >
                <Trash2 className="h-3 w-3 text-muted-foreground" />
              </Button>
            </div>

            {configs.length === 1 ? (
              (() => {
                const config = configs[0];
                const syncKey = `${config.repoId}:${config.machineSlug}`;
                const isSyncing = syncingKey === syncKey;

                return (
                  <div className="mt-1 flex items-center gap-2 rounded-lg bg-background/35 px-1.5 py-1">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${machineStatusTone(config.machineStatus)}`}
                      title={config.machineStatus}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-foreground">
                        {config.machineName}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6.5 w-6.5 rounded-md"
                      title={config.localPath}
                      aria-label={`Checkout path for ${config.machineName}`}
                    >
                      <FolderOpen className="h-3 w-3 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6.5 w-6.5 rounded-md"
                      disabled={!activeWorkspaceId || config.machineStatus === "busy" || isSyncing}
                      title="Queue repo sync on this machine"
                      onClick={() => {
                        if (!activeWorkspaceId) return;
                        setSyncingKey(syncKey);
                        void enqueueRepoSync({
                          workspaceId: activeWorkspaceId,
                          repoId: repo._id,
                          machineSlug: config.machineSlug,
                        }).finally(() => setSyncingKey(null));
                      }}
                    >
                      {isSyncing ? (
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                      ) : (
                        <RefreshCw className="h-3 w-3 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                );
              })()
            ) : configs.length > 0 ? (
              <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
                {configs.map((config) => {
                  const syncKey = `${config.repoId}:${config.machineSlug}`;
                  const isSyncing = syncingKey === syncKey;

                  return (
                    <div
                      key={config._id}
                      className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${machineStatusTone(config.machineStatus)}`}
                        title={config.machineStatus}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-foreground">
                          {config.machineName}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                        {config.machineStatus}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6.5 w-6.5 rounded-md"
                        title={config.localPath}
                        aria-label={`Checkout path for ${config.machineName}`}
                      >
                        <FolderOpen className="h-3 w-3 text-muted-foreground" />
                      </Button>
                      <div className="shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6.5 w-6.5 rounded-md"
                          disabled={!activeWorkspaceId || config.machineStatus === "busy" || isSyncing}
                          title="Queue repo sync on this machine"
                          onClick={() => {
                            if (!activeWorkspaceId) return;
                            setSyncingKey(syncKey);
                            void enqueueRepoSync({
                              workspaceId: activeWorkspaceId,
                              repoId: repo._id,
                              machineSlug: config.machineSlug,
                            }).finally(() => setSyncingKey(null));
                          }}
                        >
                          {isSyncing ? (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          ) : (
                            <RefreshCw className="h-3 w-3 text-muted-foreground" />
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                No machine checkout is registered for this workspace repo yet.
              </p>
            )}
          </div>
        ))}
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
