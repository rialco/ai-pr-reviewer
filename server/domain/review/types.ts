export type ReviewerId = "greptile" | "claude" | "codex";

export type ReviewCommentSeverity = "critical" | "major" | "minor";

export interface ReviewCommentEvidence {
  filesRead: string[];
  changedLinesChecked: string[];
  ruleReferences: string[];
  riskSummary?: string;
}

export interface Reviewer {
  id: ReviewerId;
  displayName: string;
  type: "bot" | "local-ai";
  available: boolean;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  suggestion?: string; // code suggestion block
  severity?: ReviewCommentSeverity;
  confidence?: number | null;
  evidence?: ReviewCommentEvidence | null;
}

export interface Review {
  id?: number;
  repo: string;
  prNumber: number;
  reviewerId: ReviewerId;
  confidenceScore: number | null;
  summary: string | null;
  comments?: ReviewComment[];
  source: "remote" | "local";
  githubReviewId: string | null;
  rawOutput: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewProgress {
  type: "progress" | "complete" | "error";
  step: string;
  message: string;
  progress: number; // 0-100
  detail?: string;
  review?: Review;
}
