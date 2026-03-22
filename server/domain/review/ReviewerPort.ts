import type { Review, ReviewProgress, ReviewerId } from "./types.js";

export interface PRContext {
  repo: string; // "owner/repo" label
  prNumber: number;
  prTitle: string;
  branch: string;
  localPath?: string;
}

export interface ReviewerPort {
  readonly id: ReviewerId;
  readonly displayName: string;
  readonly type: "bot" | "local-ai";

  /** Check if this reviewer can be invoked right now */
  canRequestReview(): boolean;

  /** Request a fresh review — streams progress events */
  requestReview(
    pr: PRContext,
    onProgress?: (event: ReviewProgress) => void,
    onDebug?: (debugDetail: Record<string, unknown>) => void,
  ): Promise<Review>;

  /** Fetch the latest review from this reviewer (for remote reviewers, fetches from GitHub) */
  fetchLatestReview(repo: string, prNumber: number): Promise<Review | null>;
}
