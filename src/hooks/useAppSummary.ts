import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "./useActiveWorkspace";

export function useAppSummary() {
  const { activeWorkspaceId } = useActiveWorkspace();
  return useQuery(
    api.prs.dashboardSummary,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
}
