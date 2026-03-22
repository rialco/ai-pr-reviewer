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
      .filter((f) => /^convex.*\.md$/i.test(f))
      .map((f) => ({ name: f, absPath: path.join(DOCS_DIR, f) }));
  } catch {
    return [];
  }
}

function diffTouchesConvex(diff: string): boolean {
  return [
    /(^|\n)\+\+\+\s+b\/convex\//i,
    /\bconvex\//i,
    /\bctx\.db\./,
    /\bctx\.run(?:Query|Mutation)\b/,
    /\binternal\./,
    /\bdefine(?:Schema|Table)\b/,
  ].some((pattern) => pattern.test(diff));
}

export function buildReviewPrompt(
  pr: PRContext,
  diff: string,
  hasWorktree: boolean,
  priorComments: Array<{
    path: string;
    line: number;
    body: string;
    status: string;
    analysisCategory: string;
  }> = [],
): string {
  const docFiles = listConvexDocs();
  const touchesConvex = diffTouchesConvex(diff);
  const hasConvexDocs = docFiles.length > 0 && touchesConvex;
  const accessMode = hasWorktree ? "FULL_CODEBASE" : "DIFF_ONLY";
  const priorCommentSection = priorComments.length > 0
    ? `
## Previous Local Review Comments From You

These comments come from earlier review cycles on this same PR. Use them to avoid repeating already-raised concerns unless the latest code still clearly has the same problem.

${priorComments.slice(0, 20).map((c, index) => (
  `${index + 1}. ${c.path}:${c.line} [status=${c.status}, category=${c.analysisCategory}]\n${c.body}`
)).join("\n\n")}

If the new code addresses prior concerns and no new material issues were introduced, say so in the summary and return an empty comments array.
`
    : "";

  return `You are a senior staff engineer reviewing a pull request. Your goal is to assess the overall quality, correctness, and readiness of this PR for merge.

## PR: ${pr.prTitle} (#${pr.prNumber})
Repository: ${pr.repo}
Branch: ${pr.branch}

## Access Mode
${accessMode}
${hasWorktree
    ? "You are running inside a local checkout of the PR branch. Read the changed files, then inspect only the directly related code paths, callers, tests, and contracts needed to validate your concerns."
    : "You do NOT have safe access to the target repository beyond the diff in this prompt. Do not claim you read files or searched the repo outside the diff. When evidence is partial, lower comment confidence and say so."}

## PR Diff

\`\`\`diff
${diff}
\`\`\`
${priorCommentSection}
${hasConvexDocs ? `
## Convex Best Practices Reference

This PR appears to touch Convex-related code. Local reference docs are available below if you need them. Use the **absolute paths** below to read them (they are outside the working directory):

${docFiles.map((f) => `- \`${f.absPath}\``).join("\n")}

When the diff clearly touches Convex code (files under \`convex/\`, queries, mutations, actions, schemas, \`ctx.db\`, \`internal.*\`, etc.), read the relevant docs — especially \`convex-best-practices.md\` — and flag anti-patterns such as:
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
1. Start with the changed lines and files in the diff
2. Expand only to the directly related ripple effects: callers, contracts, tests, data flow, and adjacent code paths
3. Check for bugs, security issues, correctness problems, and meaningful maintainability risks
4. Prefer concrete evidence over speculative concerns
5. Only when you find an actionable issue with clear engineering value, provide **specific inline comments** on the exact file and line
6. When suggesting code changes, include a concrete code suggestion showing the improved version
7. If you are in DIFF_ONLY mode, do not present diff-only inference as confirmed repository-wide evidence

This review must have a clear stopping condition:
- Do not create replacement comments just because older comments were addressed
- Do not repeat prior concerns unless the current code still has that exact problem
- If the PR is in good standing, explicitly say so in the summary and return an empty comments array
- Keep praise, compliments, and general observations in the summary only. Never emit a praise-only inline comment.
- Scope the review to changed code and direct ripple effects. Do not audit untouched subsystems unless the diff points there.

## Response Format

You MUST respond with a JSON object (no markdown code blocks, just raw JSON):
{
  "confidenceScore": <number 1-5>,
  "summary": "<2-4 paragraph assessment of the PR>",
  "comments": [
    {
      "path": "<file path relative to repo root, e.g. src/components/Foo.tsx>",
      "line": <line number in the NEW version of the file where the comment applies>,
      "severity": "critical" | "major" | "minor",
      "confidence": <number 1-5>,
      "body": "<explanation of the issue or suggestion>",
      "suggestion": "<optional: the improved code to replace the line(s). Only include when you have a concrete fix. This will be rendered as a GitHub suggestion block.>",
      "evidence": {
        "filesRead": ["<files actually inspected or visible in the diff>"],
        "changedLinesChecked": ["<functions / blocks / hunks checked>"],
        "ruleReferences": ["<optional docs, standards, or invariants consulted>"],
        "riskSummary": "<one sentence on the concrete risk>"
      }
    }
  ]
}

### Comment guidelines:
- Only include comments for things that **actually matter**: bugs, security issues, performance problems, Convex anti-patterns, or significant code quality concerns
- Do NOT comment on style preferences, minor formatting, or trivial naming choices
- Do NOT use inline comments for praise, acknowledgements, or non-actionable observations
- A comment must describe something worth developer attention before or shortly after merge. If it would not meaningfully change the ship/no-ship decision or improve the code in a concrete way, leave it out.
- The "line" must be a line number that appears in the NEW version of the changed files (the + side of the diff)
- The "path" must match the file path exactly as shown in the diff header (e.g. "convex/messages.ts")
- For code suggestions, put ONLY the replacement code in the "suggestion" field — it will be wrapped in a GitHub suggestion block automatically
- Use severity to indicate impact: critical = merge-blocking correctness/security risk, major = important but not catastrophic, minor = low-risk worthwhile issue
- Use confidence to reflect how strongly the available evidence supports the comment
- Comment count should be a consequence of issue severity, not a target. Zero comments is correct when the PR is in good standing.
- If confidenceScore is 4 or 5, comments should be rare and reserved for material points.

Confidence scale:
- 5: Ready to merge. No issues found, clean code, well-tested.
- 4: Safe to merge. At most a very small number of non-blocking but worthwhile comments.
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

function extractFirstBalancedJsonObject(text: string): string | null {
  let start = text.indexOf("{");

  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }

        if (char === "\\") {
          escaping = true;
          continue;
        }

        if (char === "\"") {
          inString = false;
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }

    start = text.indexOf("{", start + 1);
  }

  return null;
}

function extractJsonStringField(text: string, fieldName: string): string | null {
  const fieldStart = text.indexOf(`"${fieldName}"`);
  if (fieldStart === -1) return null;

  const colonIndex = text.indexOf(":", fieldStart);
  if (colonIndex === -1) return null;

  let quoteIndex = colonIndex + 1;
  while (quoteIndex < text.length && /\s/.test(text[quoteIndex])) {
    quoteIndex += 1;
  }

  if (text[quoteIndex] !== "\"") return null;

  let escaping = false;
  for (let i = quoteIndex + 1; i < text.length; i++) {
    const char = text[i];
    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      try {
        return JSON.parse(text.slice(quoteIndex, i + 1)) as string;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function tryParseReviewJson(candidate: string): ParsedReview | null {
  try {
    const parsed = JSON.parse(candidate) as {
      confidenceScore: number;
      summary: string;
      comments?: Array<{
        path: string;
        line: number;
        body: string;
        suggestion?: string;
        severity?: ReviewComment["severity"];
        confidence?: number | null;
        evidence?: ReviewComment["evidence"] | null;
      }>;
    };

    const comments: ReviewComment[] = [];
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (c.path && typeof c.line === "number" && c.body) {
          const evidence = c.evidence && typeof c.evidence === "object"
            ? {
                filesRead: Array.isArray(c.evidence.filesRead)
                  ? c.evidence.filesRead.filter((value): value is string => typeof value === "string")
                  : [],
                changedLinesChecked: Array.isArray(c.evidence.changedLinesChecked)
                  ? c.evidence.changedLinesChecked.filter((value): value is string => typeof value === "string")
                  : [],
                ruleReferences: Array.isArray(c.evidence.ruleReferences)
                  ? c.evidence.ruleReferences.filter((value): value is string => typeof value === "string")
                  : [],
                riskSummary: typeof c.evidence.riskSummary === "string" ? c.evidence.riskSummary : undefined,
              }
            : null;

          comments.push({
            path: c.path,
            line: c.line,
            body: c.body,
            suggestion: c.suggestion || undefined,
            severity:
              c.severity === "critical" || c.severity === "major" || c.severity === "minor"
                ? c.severity
                : undefined,
            confidence:
              typeof c.confidence === "number" && Number.isFinite(c.confidence)
                ? Math.max(1, Math.min(5, Math.round(c.confidence)))
                : null,
            evidence: evidence && (
              evidence.riskSummary ||
              evidence.filesRead.length > 0 ||
              evidence.changedLinesChecked.length > 0 ||
              evidence.ruleReferences.length > 0
            )
              ? evidence
              : null,
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
    return null;
  }
}

export function parseReviewOutput(raw: string): ParsedReview {
  let cleaned = raw.trim();

  // Extract from code block if wrapped
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  const candidates = [cleaned];
  const balancedJson = extractFirstBalancedJsonObject(cleaned);
  if (balancedJson && balancedJson !== cleaned) {
    candidates.push(balancedJson);
  }

  for (const candidate of candidates) {
    const parsed = tryParseReviewJson(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const jsonScoreMatch = raw.match(/"confidenceScore"\s*:\s*(\d+)/);
  const textScoreMatch = raw.match(/[Cc]onfidence(?:\s*[Ss]core)?:\s*(\d)\/5/);
  const summary =
    extractJsonStringField(cleaned, "summary") ??
    extractJsonStringField(raw, "summary") ??
    raw.slice(0, 500);

  return {
    confidenceScore: jsonScoreMatch
      ? parseInt(jsonScoreMatch[1], 10)
      : textScoreMatch
        ? parseInt(textScoreMatch[1], 10)
        : 3,
    summary,
    comments: [],
  };
}

/** Format a ReviewComment body for GitHub, wrapping suggestion in a suggestion block. */
export function formatGitHubCommentBody(comment: ReviewComment): string {
  let body = comment.body;
  if (comment.suggestion) {
    body += `\n\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
  }
  return body;
}
