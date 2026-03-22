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

export type AnalysisVerdict = "ACTIONABLE" | "DISMISS" | "ALREADY_ADDRESSED";

export type AnalysisSeverity =
  | "MUST_FIX"
  | "SHOULD_FIX"
  | "NICE_TO_HAVE";

export type AnalysisAccessMode = "FULL_CODEBASE" | "DIFF_ONLY";

export interface AnalysisEvidence {
  filesRead: string[];
  symbolsChecked: string[];
  callersChecked: string[];
  testsChecked: string[];
  riskSummary?: string;
  validationNotes?: string;
}

export interface AnalysisResult {
  commentId: number;
  category: AnalysisCategory;
  reasoning: string;
  verdict?: AnalysisVerdict;
  severity?: AnalysisSeverity | null;
  confidence?: number | null;
  accessMode?: AnalysisAccessMode;
  evidence?: AnalysisEvidence | null;
  currentCode?: string;
}

export type RunHistoryStepStatus = "active" | "done" | "error";

export interface RunHistoryStep {
  step: string;
  status: RunHistoryStepStatus;
  detail?: string;
  ts: string;
}

export type PersistedRunStatus = "running" | "done" | "error";

export interface PersistedRunHistory {
  status: PersistedRunStatus;
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  detail?: string;
  steps: RunHistoryStep[];
  output: string[];
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
  | "merge_ready"
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
  coordinatorEnabled: boolean;
  coordinatorAgent: "claude" | "codex";
  defaultAnalyzerAgent: "claude" | "codex";
  defaultFixerAgent: "claude" | "codex";
  defaultReviewerIds: Array<"greptile" | "claude" | "codex">;
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
