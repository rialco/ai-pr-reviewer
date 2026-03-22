import { execSync } from "child_process";
import type { ReviewerPort, PRContext } from "../../domain/review/ReviewerPort.js";
import type { Review, ReviewProgress, ReviewerId } from "../../domain/review/types.js";
import { postPRComment } from "../../services/github.js";
import {
  insertReview,
  getLatestReview,
  getCommentsByPR,
  getPRState,
} from "../../services/db.js";

const GREPTILE_USER = "greptile-apps[bot]";

function gh(args: string): string {
  return execSync(`gh ${args}`, { encoding: "utf-8", timeout: 30000 });
}

/**
 * Parse the Greptile confidence score from a review body.
 * Greptile uses various formats:
 *   - "Confidence: 3/5"
 *   - "Confidence Score: 3/5"
 *   - "<h3>Confidence Score: 3/5</h3>" (HTML)
 * Returns null if no score pattern found.
 */
function parseConfidenceScore(body: string): number | null {
  // Strip HTML tags for matching
  const stripped = body.replace(/<[^>]*>/g, "");
  const match = stripped.match(/Confidence(?:\s+Score)?:\s*(\d)\s*\/\s*5/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract a clean summary from a Greptile review body.
 * Greptile uses HTML formatting, so we strip tags.
 */
function extractSummary(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")  // strip HTML tags
    .replace(/^#+\s.*$/gm, "") // strip markdown headers
    .replace(/\s+/g, " ")      // normalize whitespace
    .trim()
    .slice(0, 500);
}

export class GreptileReviewer implements ReviewerPort {
  readonly id: ReviewerId = "greptile";
  readonly displayName = "Greptile";
  readonly type = "bot" as const;

  canRequestReview(): boolean {
    return true; // We can always post an @greptileai comment
  }

  async requestReview(
    pr: PRContext,
    onProgress?: (event: ReviewProgress) => void,
    onDebug?: (debugDetail: Record<string, unknown>) => void,
  ): Promise<Review> {
    const emit = (e: ReviewProgress) => onProgress?.(e);

    emit({
      type: "progress",
      step: "building_request",
      message: "Building re-review request with fix context...",
      progress: 20,
    });

    const body = this.buildReReviewBody(pr.repo, pr.prNumber);
    onDebug?.({
      reviewerId: this.id,
      reviewerName: this.displayName,
      repo: pr.repo,
      prNumber: pr.prNumber,
      prTitle: pr.prTitle,
      branch: pr.branch,
      source: "github_comment",
      prompt: body,
    });

    emit({
      type: "progress",
      step: "posting_comment",
      message: "Posting re-review request to Greptile...",
      progress: 50,
    });

    await postPRComment(pr.repo, pr.prNumber, body);

    emit({
      type: "progress",
      step: "waiting",
      message: "Re-review request posted. Greptile will update the score asynchronously.",
      progress: 100,
    });

    // Return whatever score exists now
    const existing = await this.fetchLatestReview(pr.repo, pr.prNumber);

    const review: Review = {
      repo: pr.repo,
      prNumber: pr.prNumber,
      reviewerId: "greptile",
      confidenceScore: existing?.confidenceScore ?? null,
      summary: existing?.summary ?? "Re-review requested — waiting for Greptile to respond.",
      source: "remote",
      githubReviewId: existing?.githubReviewId ?? null,
      rawOutput: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    emit({ type: "complete", step: "done", message: "Re-review requested", progress: 100, review });
    return review;
  }

  /**
   * Fetch the latest Greptile review.
   *
   * Primary source: the `comments` table (type "review", user "greptile-apps[bot]").
   * These are already fetched by the poller/refresh flow via fetchBotComments(),
   * so this requires zero additional API calls in the normal case.
   *
   * Fallback: direct GitHub API call if nothing is in the comments table yet.
   */
  async fetchLatestReview(repo: string, prNumber: number): Promise<Review | null> {
    // 1. Try to extract from already-fetched comments in DB
    const fromComments = this.extractFromComments(repo, prNumber);
    if (fromComments) return fromComments;

    // 2. Fallback: direct GitHub API (only needed on first load before any sync)
    return this.fetchFromGitHub(repo, prNumber);
  }

  /**
   * Extract the Greptile score from comments already stored in our DB.
   * The poller fetches review-type comments from greptile-apps[bot] and stores them
   * in the comments table. We just need to find the latest one and parse the score.
   */
  private extractFromComments(repo: string, prNumber: number): Review | null {
    const comments = getCommentsByPR(repo, prNumber);

    // Find the latest greptile comment that contains a confidence score.
    // Greptile posts the score in issue_comment or review types, often in HTML.
    const greptileReviews = comments
      .filter((c) => c.user === GREPTILE_USER && parseConfidenceScore(c.body) !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (greptileReviews.length === 0) return null;

    const latest = greptileReviews[0];
    const confidenceScore = parseConfidenceScore(latest.body);
    const summary = extractSummary(latest.body);

    const review: Review = {
      repo,
      prNumber,
      reviewerId: "greptile",
      confidenceScore,
      summary,
      source: "remote",
      githubReviewId: String(latest.id),
      rawOutput: latest.body,
      createdAt: latest.createdAt,
      updatedAt: latest.createdAt,
    };

    // Persist to reviews table
    insertReview(review);

    return review;
  }

  /**
   * Direct GitHub API fallback — used only when comments haven't been synced yet.
   * Checks both PR reviews and issue comments since Greptile posts the score
   * as an issue comment (not a review).
   */
  private fetchFromGitHub(repo: string, prNumber: number): Review | null {
    // Try issue comments first (where Greptile actually posts the confidence score)
    try {
      const raw = gh(
        `api repos/${repo}/issues/${prNumber}/comments --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last'`,
      );

      const trimmed = raw.trim();
      if (trimmed && trimmed !== "null") {
        const commentData = JSON.parse(trimmed) as {
          id: number;
          body: string;
          created_at: string;
        };

        const confidenceScore = parseConfidenceScore(commentData.body);
        if (confidenceScore !== null) {
          const review: Review = {
            repo,
            prNumber,
            reviewerId: "greptile",
            confidenceScore,
            summary: extractSummary(commentData.body),
            source: "remote",
            githubReviewId: String(commentData.id),
            rawOutput: commentData.body,
            createdAt: commentData.created_at,
            updatedAt: commentData.created_at,
          };
          insertReview(review);
          return review;
        }
      }
    } catch {
      // Continue to next fallback
    }

    // Also check PR reviews (in case format changes)
    try {
      const raw = gh(
        `api repos/${repo}/pulls/${prNumber}/reviews --jq '[.[] | select(.user.login == "greptile-apps[bot]")] | last'`,
      );

      const trimmed = raw.trim();
      if (trimmed && trimmed !== "null") {
        const reviewData = JSON.parse(trimmed) as {
          id: number;
          body: string;
          submitted_at: string;
        };

        const confidenceScore = parseConfidenceScore(reviewData.body);
        if (confidenceScore !== null) {
          const review: Review = {
            repo,
            prNumber,
            reviewerId: "greptile",
            confidenceScore,
            summary: extractSummary(reviewData.body),
            source: "remote",
            githubReviewId: String(reviewData.id),
            rawOutput: reviewData.body,
            createdAt: reviewData.submitted_at,
            updatedAt: reviewData.submitted_at,
          };
          insertReview(review);
          return review;
        }
      }
    } catch {
      // Fall through
    }

    // Final fallback: whatever is in the reviews table
    return getLatestReview(repo, prNumber, "greptile");
  }

  /**
   * Build a re-review comment body with fix context.
   */
  private buildReReviewBody(repo: string, prNumber: number): string {
    const comments = getCommentsByPR(repo, prNumber);
    const prState = getPRState(repo, prNumber);
    const lastReReviewAt = prState?.lastReReviewAt ?? null;

    const fixedComments = comments.filter((c) => {
      if (c.status !== "fixed" || !c.fixResult) return false;
      if (lastReReviewAt && c.fixResult.fixedAt <= lastReReviewAt) return false;
      return true;
    });

    if (fixedComments.length === 0) {
      return "@greptileai Please re-review this PR.\n\nFocus on newly changed code and direct ripple effects only. Please do not repeat concerns that are already addressed unless the latest diff clearly reintroduces them. Please include an updated **Confidence: X/5** score in your review.";
    }

    const allFixResults = prState?.fixResults ?? [];
    const fixResults = lastReReviewAt
      ? allFixResults.filter((r) => r.fixedAt > lastReReviewAt)
      : allFixResults;

    const commitHashes = [...new Set(fixResults.map((r) => r.commitHash))];
    const allFiles = [...new Set(fixResults.flatMap((r) => r.filesChanged))];

    const addressedList = fixedComments.map((c) => {
      const category = c.analysis?.category ?? "SHOULD_FIX";
      const file = c.path ? `\`${c.path}\`` : "general";
      const bodyText = c.body
        .replace(/<[^>]*>/g, "")
        .trim()
        .split("\n")[0]
        .slice(0, 100);
      return `- **[${category}]** ${file}: ${bodyText}`;
    });

    return `@greptileai Please re-review this PR.

## Summary of Fixes

${fixedComments.length} review comment${fixedComments.length !== 1 ? "s" : ""} addressed in ${commitHashes.length} commit${commitHashes.length !== 1 ? "s" : ""} (${commitHashes.join(", ")}).

### Addressed Comments
${addressedList.join("\n")}

### Modified Files
${allFiles.map((f) => `- \`${f}\``).join("\n")}

Please focus on the modified files and direct ripple effects, avoid repeating already-addressed concerns, and include an updated **Confidence: X/5** score in your review.`;
  }
}
