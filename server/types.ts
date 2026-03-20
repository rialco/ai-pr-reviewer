export interface RepoConfig {
  owner: string;
  repo: string;
  label: string; // e.g. "ATID-Solutions/binah"
  botUsers: string[];
  localPath?: string;
}

export interface PRInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  author: string;
  repo: string; // "owner/repo"
  createdAt: string;
  updatedAt: string;
}

export interface BotComment {
  id: number;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  repo: string;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  body: string;
  user: string;
  createdAt: string;
  url: string | null;
  type: "inline" | "review" | "issue_comment";
}

export type AnalysisCategory =
  | "MUST_FIX"
  | "SHOULD_FIX"
  | "NICE_TO_HAVE"
  | "DISMISS"
  | "ALREADY_ADDRESSED";

export interface AnalysisResult {
  commentId: number;
  category: AnalysisCategory;
  reasoning: string;
  currentCode?: string;
}

export interface CommentState {
  commentId: number;
  repo: string;
  prNumber: number;
  status: "new" | "analyzing" | "analyzed" | "fixing" | "fixed" | "fix_failed" | "dismissed";
  analysis?: AnalysisResult;
  fixResult?: FixResult;
  seenAt: string;
}

export interface FixResult {
  commentId: number;
  filesChanged: string[];
  commitHash: string;
  commitMessage: string;
  fixedAt: string;
}

export type PRPhase =
  | "polled"
  | "analyzed"
  | "fixing"
  | "fixed"
  | "re_review_requested"
  | "waiting_for_review";

export interface PRState {
  repo: string;
  prNumber: number;
  reviewCycle: number;
  confidenceScore: number | null;
  phase: PRPhase;
  lastFixedAt: string | null;
  lastReReviewAt: string | null;
  fixResults: FixResult[];
}

export interface AppSettings {
  autoReReview: boolean; // Whether to post @greptileai re-review comment after fixing
}

export interface AppState {
  repos: RepoConfig[];
  comments: Record<string, CommentState>; // keyed by `${repo}:${commentId}`
  prs: Record<string, PRState>; // keyed by `${repo}:${prNumber}`
  settings: AppSettings;
  lastPollAt: string | null;
}

export const DEFAULT_BOT_USERS = [
  "greptile-apps[bot]",
  "Copilot",
  "copilot-pull-request-reviewer[bot]",
];
