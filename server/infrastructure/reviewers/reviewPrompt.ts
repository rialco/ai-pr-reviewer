import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { PRContext } from "../../domain/review/ReviewerPort.js";
import type { ReviewComment } from "../../domain/review/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, "../../../docs");

/** List available doc files with their absolute paths. */
function listConvexDocs(): Array<{ name: string; absPath: string }> {
  try {
    return fs
      .readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, absPath: path.join(DOCS_DIR, f) }));
  } catch {
    return [];
  }
}

export function buildReviewPrompt(
  pr: PRContext,
  diff: string,
  hasWorktree: boolean,
): string {
  const docFiles = listConvexDocs();
  const hasConvexDocs = docFiles.length > 0;

  return `You are a senior staff engineer reviewing a pull request. Your goal is to assess the overall quality, correctness, and readiness of this PR for merge.

## PR: ${pr.prTitle} (#${pr.prNumber})
Repository: ${pr.repo}
Branch: ${pr.branch}
${hasWorktree ? "\n**You are running inside a local checkout of this repository at the PR branch. Use your Read, Grep, Glob, and other file tools to explore the full codebase for context.**\n" : ""}
## PR Diff

\`\`\`diff
${diff}
\`\`\`
${hasConvexDocs ? `
## Convex Best Practices Reference

This project uses **Convex** as its backend. The following documentation files contain Convex best practices you should consult when reviewing Convex-related code. Use the **absolute paths** below to read them (they are outside the working directory):

${docFiles.map((f) => `- \`${f.absPath}\``).join("\n")}

**If the PR touches any Convex code** (files under \`convex/\`, database queries, mutations, actions, schemas, etc.), read the relevant docs — especially \`convex-best-practices.md\` — and flag any anti-patterns such as:
- Missing argument validators on public functions
- Unbounded \`.collect()\` without indexes
- Using \`.filter()\` on database queries instead of \`.withIndex()\`
- \`Date.now()\` in queries
- Using \`api.*\` instead of \`internal.*\` for scheduled/cron functions
- Missing access control on public functions
- Sequential \`ctx.runMutation\`/\`ctx.runQuery\` calls in actions that should be batched
- \`ctx.db.get()\`/\`patch()\`/\`delete()\` without the table name as first argument
` : ""}
## Your Task

Review this PR thoroughly:
1. Read the relevant files to understand the full context
2. Check for bugs, security issues, correctness problems
3. Assess code quality, maintainability, and adherence to best practices
4. Consider edge cases and error handling
5. For any code that could be improved, provide **specific inline comments** on the exact file and line
6. When suggesting code changes, include a concrete code suggestion showing the improved version

## Response Format

You MUST respond with a JSON object (no markdown code blocks, just raw JSON):
{
  "confidenceScore": <number 1-5>,
  "summary": "<2-4 paragraph assessment of the PR>",
  "comments": [
    {
      "path": "<file path relative to repo root, e.g. src/components/Foo.tsx>",
      "line": <line number in the NEW version of the file where the comment applies>,
      "body": "<explanation of the issue or suggestion>",
      "suggestion": "<optional: the improved code to replace the line(s). Only include when you have a concrete fix. This will be rendered as a GitHub suggestion block.>"
    }
  ]
}

### Comment guidelines:
- Only include comments for things that **actually matter**: bugs, security issues, performance problems, Convex anti-patterns, or significant code quality concerns
- Do NOT comment on style preferences, minor formatting, or trivial naming choices
- The "line" must be a line number that appears in the NEW version of the changed files (the + side of the diff)
- The "path" must match the file path exactly as shown in the diff header (e.g. "convex/messages.ts")
- For code suggestions, put ONLY the replacement code in the "suggestion" field — it will be wrapped in a GitHub suggestion block automatically
- Aim for 3-10 comments. Skip the review comments if the code is clean — a high confidence score with just a summary is fine

Confidence scale:
- 5: Ready to merge. No issues found, clean code, well-tested.
- 4: Minor suggestions only. No bugs or security issues. Safe to merge.
- 3: Some concerns that should be addressed. Moderate issues found.
- 2: Significant issues. Bugs, security concerns, or major quality problems.
- 1: Critical issues. Do not merge. Requires substantial rework.

Be thorough but fair. Focus on what matters — correctness, security, performance — not style preferences.`;
}

export interface ParsedReview {
  confidenceScore: number;
  summary: string;
  comments: ReviewComment[];
}

export function parseReviewOutput(raw: string): ParsedReview {
  let cleaned = raw.trim();

  // Extract from code block if wrapped
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Find JSON object
  if (!cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }

  try {
    const parsed = JSON.parse(cleaned) as {
      confidenceScore: number;
      summary: string;
      comments?: Array<{
        path: string;
        line: number;
        body: string;
        suggestion?: string;
      }>;
    };

    const comments: ReviewComment[] = [];
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (c.path && typeof c.line === "number" && c.body) {
          comments.push({
            path: c.path,
            line: c.line,
            body: c.body,
            suggestion: c.suggestion || undefined,
          });
        }
      }
    }

    return {
      confidenceScore: Math.max(1, Math.min(5, Math.round(parsed.confidenceScore))),
      summary: parsed.summary ?? "No summary provided.",
      comments,
    };
  } catch {
    const scoreMatch = raw.match(/[Cc]onfidence(?:\s*[Ss]core)?:\s*(\d)\/5/);
    return {
      confidenceScore: scoreMatch ? parseInt(scoreMatch[1], 10) : 3,
      summary: raw.slice(0, 500),
      comments: [],
    };
  }
}

/** Format a ReviewComment body for GitHub, wrapping suggestion in a suggestion block. */
export function formatGitHubCommentBody(comment: ReviewComment): string {
  let body = comment.body;
  if (comment.suggestion) {
    body += `\n\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
  }
  return body;
}
