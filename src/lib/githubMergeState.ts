export type GitHubMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

export interface GitHubMergeStateDetails {
  label: string;
  description: string;
  tone: "success" | "warning" | "danger" | "muted";
  isBlocked: boolean;
}

const MERGE_STATE_DETAILS: Record<GitHubMergeStateStatus, GitHubMergeStateDetails> = {
  BEHIND: {
    label: "Branch out of date",
    description: "GitHub reports that the PR branch is behind the base branch and should be updated before merge work continues.",
    tone: "warning",
    isBlocked: true,
  },
  BLOCKED: {
    label: "Merge blocked",
    description: "GitHub reports that merging is blocked. This usually means a required review, status check, or repository rule still needs attention.",
    tone: "warning",
    isBlocked: true,
  },
  CLEAN: {
    label: "Ready to merge",
    description: "GitHub reports that the PR is mergeable and its commit status is passing.",
    tone: "success",
    isBlocked: false,
  },
  DIRTY: {
    label: "Merge conflicts",
    description: "GitHub cannot create the merge commit cleanly, which means the PR currently has merge conflicts with the base branch.",
    tone: "danger",
    isBlocked: true,
  },
  DRAFT: {
    label: "Draft pull request",
    description: "GitHub reports that merging is blocked because the pull request is still marked as a draft.",
    tone: "muted",
    isBlocked: true,
  },
  HAS_HOOKS: {
    label: "Ready, with hooks",
    description: "GitHub reports that the PR is mergeable and passing status checks, with pre-receive hooks configured on the repository.",
    tone: "success",
    isBlocked: false,
  },
  UNKNOWN: {
    label: "State still loading",
    description: "GitHub cannot determine the merge state yet. This usually settles after GitHub finishes recalculating checks and mergeability.",
    tone: "muted",
    isBlocked: false,
  },
  UNSTABLE: {
    label: "Checks failing",
    description: "GitHub reports that the PR is mergeable, but its commit status is not passing. That is the source of the UNSTABLE label.",
    tone: "warning",
    isBlocked: false,
  },
};

export function getGitHubMergeStateDetails(
  state: GitHubMergeStateStatus | null | undefined,
): GitHubMergeStateDetails | null {
  if (!state) return null;
  return MERGE_STATE_DETAILS[state] ?? null;
}
