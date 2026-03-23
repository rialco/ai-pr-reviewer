import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSummary } from "./useApi";
import { useActiveWorkspace } from "./useActiveWorkspace";
import { hasCloudEnv } from "../lib/cloud";

export function useAppSummary() {
  if (hasCloudEnv) {
    const { activeWorkspaceId } = useActiveWorkspace();
    return useQuery(
      api.prs.dashboardSummary,
      activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
    );
  }

  return useSummary().data;
}
