import type { ReviewerPort, PRContext } from "./ReviewerPort.js";
import type { Review, Reviewer, ReviewerId, ReviewProgress } from "./types.js";

export class ReviewService {
  private reviewers: Map<ReviewerId, ReviewerPort>;

  constructor(reviewers: ReviewerPort[]) {
    this.reviewers = new Map(reviewers.map((r) => [r.id, r]));
  }

  getAvailableReviewers(): Reviewer[] {
    return [...this.reviewers.values()].map((r) => ({
      id: r.id,
      displayName: r.displayName,
      type: r.type,
      available: r.canRequestReview(),
    }));
  }

  getReviewer(id: ReviewerId): ReviewerPort | undefined {
    return this.reviewers.get(id);
  }

  async requestReview(
    reviewerId: ReviewerId,
    pr: PRContext,
    onProgress?: (event: ReviewProgress) => void,
    onDebug?: (debugDetail: Record<string, unknown>) => void,
  ): Promise<Review> {
    const reviewer = this.reviewers.get(reviewerId);
    if (!reviewer) {
      throw new Error(`Unknown reviewer: ${reviewerId}`);
    }
    if (!reviewer.canRequestReview()) {
      throw new Error(`Reviewer ${reviewerId} is not available`);
    }
    return reviewer.requestReview(pr, onProgress, onDebug);
  }

  async fetchLatestReviews(
    repo: string,
    prNumber: number,
  ): Promise<Map<ReviewerId, Review | null>> {
    const results = new Map<ReviewerId, Review | null>();
    for (const [id, reviewer] of this.reviewers) {
      try {
        const review = await reviewer.fetchLatestReview(repo, prNumber);
        results.set(id, review);
      } catch {
        results.set(id, null);
      }
    }
    return results;
  }
}
