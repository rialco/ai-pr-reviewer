import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSummary } from "../hooks/useApi";
import { useActiveWorkspace } from "../hooks/useActiveWorkspace";
import { hasCloudEnv } from "../lib/cloud";

function LocalRepoCountBadge() {
  const { data: summary } = useSummary();

  return (
    <span className="rounded-full border border-border/70 bg-muted/20 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {summary?.repos ?? 0} Repo{summary?.repos === 1 ? "" : "s"}
    </span>
  );
}

function CloudRepoCountBadge() {
  const { activeWorkspaceId } = useActiveWorkspace();
  const repos = useQuery(
    api.repos.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );

  return (
    <span className="rounded-full border border-border/70 bg-muted/20 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {repos?.length ?? 0} Repo{repos?.length === 1 ? "" : "s"}
    </span>
  );
}

export function AppRepoCountBadge() {
  return hasCloudEnv ? <CloudRepoCountBadge /> : <LocalRepoCountBadge />;
}
