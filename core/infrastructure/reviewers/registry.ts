import type { ReviewerPort } from "../../domain/review/ReviewerPort.js";
import { ReviewService } from "../../domain/review/ReviewService.js";
import { GreptileReviewer } from "./GreptileReviewer.js";
import { ClaudeReviewer } from "./ClaudeReviewer.js";
import { CodexReviewer } from "./CodexReviewer.js";

let _service: ReviewService | null = null;

export function getReviewService(): ReviewService {
  if (!_service) {
    const reviewers: ReviewerPort[] = [
      new GreptileReviewer(),
      new ClaudeReviewer(),
      new CodexReviewer(),
    ];
    _service = new ReviewService(reviewers);
  }
  return _service;
}
