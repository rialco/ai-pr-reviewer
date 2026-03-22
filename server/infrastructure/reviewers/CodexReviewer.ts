import { spawn, execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import type { ReviewerPort, PRContext } from "../../domain/review/ReviewerPort.js";
import type { Review, ReviewProgress, ReviewerId } from "../../domain/review/types.js";
import { getPRDiff } from "../../services/github.js";
import {
  getCurrentReviewCommentsByReviewer,
  insertReview,
  getLatestReview,
  saveReviewComments,
} from "../../services/db.js";
import {
  buildReviewPrompt,
  parseReviewOutput,
} from "./reviewPrompt.js";

const execAsync = promisify(exec);
const CODEX_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

export class CodexReviewer implements ReviewerPort {
  readonly id: ReviewerId = "codex";
  readonly displayName = "Codex";
  readonly type = "local-ai" as const;

  canRequestReview(): boolean {
    try {
      execSync("which codex", { encoding: "utf-8", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async requestReview(
    pr: PRContext,
    onProgress?: (event: ReviewProgress) => void,
    onDebug?: (debugDetail: Record<string, unknown>) => void,
  ): Promise<Review> {
    const emit = (e: ReviewProgress) => onProgress?.(e);

    // Step 1: Get PR diff
    emit({
      type: "progress",
      step: "fetching_diff",
      message: "Fetching PR diff...",
      progress: 10,
    });
    const prDiff = await getPRDiff(pr.repo, pr.prNumber, pr.localPath, pr.branch);
    if (!prDiff) throw new Error("Could not fetch PR diff");

    // Step 2: Set up worktree if local path available
    let workDir: string | undefined;
    let cleanupWorkDir: (() => Promise<void>) | undefined;

    if (pr.localPath && pr.branch) {
      emit({
        type: "progress",
        step: "setting_up_worktree",
        message: "Setting up local worktree for codebase access...",
        progress: 20,
      });
      try {
        await execAsync("git fetch origin", { cwd: pr.localPath, timeout: 60000 });
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-codex-"));
        await execAsync(`git worktree add ${tmpDir} origin/${pr.branch}`, {
          cwd: pr.localPath,
          timeout: 60000,
        });
        workDir = tmpDir;
        cleanupWorkDir = async () => {
          await execAsync(`git worktree remove ${JSON.stringify(tmpDir)} --force`, {
            cwd: pr.localPath,
          });
        };
      } catch (err) {
        emit({
          type: "progress",
          step: "worktree_warning",
          message: `Could not set up worktree: ${err}. Review will use diff only.`,
          progress: 22,
        });
      }
    }

    // Step 3: Build prompt
    emit({
      type: "progress",
      step: "building_prompt",
      message: "Building review prompt...",
      progress: 30,
    });

    const maxDiffLen = 30000;
    const truncatedDiff =
      prDiff.length > maxDiffLen
        ? prDiff.slice(0, maxDiffLen) + "\n... (diff truncated)"
        : prDiff;

    const priorComments = getCurrentReviewCommentsByReviewer(pr.repo, pr.prNumber, this.id)
      .map((comment) => ({
        path: comment.path,
        line: comment.line,
        body: comment.body,
        status: comment.status,
        analysisCategory: comment.analysisCategory,
      }));

    const prompt = buildReviewPrompt(pr, truncatedDiff, !!workDir, priorComments);
    onDebug?.({
      reviewerId: this.id,
      reviewerName: this.displayName,
      repo: pr.repo,
      prNumber: pr.prNumber,
      prTitle: pr.prTitle,
      branch: pr.branch,
      hasWorktree: Boolean(workDir),
      diffLength: prDiff.length,
      diffTruncated: truncatedDiff !== prDiff,
      priorCommentCount: priorComments.length,
      prompt,
    });

    // Step 4: Run Codex
    emit({
      type: "progress",
      step: "running_codex",
      message: "Codex is reviewing the PR...",
      progress: 40,
      detail: "This may take 1-3 minutes.",
    });

    let result: string;
    try {
      result = await runCodexReview(workDir ?? process.cwd(), prompt, (line) => {
        emit({
          type: "progress",
          step: "codex_output",
          message: line,
          progress: 60,
        });
      });
    } finally {
      if (cleanupWorkDir) {
        try { await cleanupWorkDir(); } catch {}
      }
    }

    // Step 5: Parse result
    emit({
      type: "progress",
      step: "parsing",
      message: "Parsing Codex's review...",
      progress: 85,
    });

    const parsed = parseReviewOutput(result);

    // Step 6: Save review comments locally (publish to GitHub is a separate manual step)
    emit({
      type: "progress",
      step: "saving_comments",
      message:
        parsed.comments.length > 0
          ? `Saving ${parsed.comments.length} local comment(s)...`
          : "No actionable review comments. Preserving prior runs and superseding stale open comments...",
      progress: 90,
    });
    saveReviewComments(pr.repo, pr.prNumber, "codex", parsed.comments);

    const review: Review = {
      repo: pr.repo,
      prNumber: pr.prNumber,
      reviewerId: "codex",
      confidenceScore: parsed.confidenceScore,
      summary: parsed.summary,
      comments: parsed.comments,
      source: "local",
      githubReviewId: null,
      rawOutput: result,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    insertReview(review);

    emit({
      type: "complete",
      step: "done",
      message: `Review complete — Confidence: ${parsed.confidenceScore}/5, ${parsed.comments.length} comment(s)`,
      progress: 100,
      review,
    });

    return review;
  }

  async fetchLatestReview(repo: string, prNumber: number): Promise<Review | null> {
    return getLatestReview(repo, prNumber, "codex");
  }
}

function runCodexReview(
  cwd: string,
  prompt: string,
  onOutput?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--full-auto", prompt],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.trim()) onOutput?.(line.trim());
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Codex review timed out after ${Math.floor(CODEX_REVIEW_TIMEOUT_MS / 60000)} minutes`));
    }, CODEX_REVIEW_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        // Strip ANSI escape codes and extract the meaningful error
        const cleanStderr = stderr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim();
        const errorLine = cleanStderr
          .split("\n")
          .filter((l) => l.trim())
          .find((l) => /error/i.test(l));
        const message = errorLine?.replace(/^ERROR:\s*/i, "").trim() || cleanStderr.split("\n").pop()?.trim() || "Unknown error";
        reject(new Error(`Codex review failed: ${message}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
