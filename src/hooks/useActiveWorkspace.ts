import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useActiveWorkspace() {
  const workspaces = useQuery(api.workspaces.listForCurrentUser);
  const activeWorkspace = workspaces?.[0] ?? null;

  return {
    workspaces,
    activeWorkspace,
    activeWorkspaceId: activeWorkspace?._id ?? null,
  };
}
