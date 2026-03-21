import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  RepoConfig,
  BotComment,
  AnalysisResult,
  FixResult,
  PRState,
  PRPhase,
  AppSettings,
  CommentState,
} from "../types.js";
import { DEFAULT_BOT_USERS } from "../types.js";
import type { Review, ReviewerId } from "../domain/review/types.js";

const DB_PATH = path.join(import.meta.dirname, "../../data/pr-reviewer.db");

let _db: Database.Database | null = null;

export function getDB(): Database.Database {
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      label TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      bot_users TEXT NOT NULL DEFAULT '[]',
      local_path TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_title TEXT NOT NULL DEFAULT '',
      pr_url TEXT NOT NULL DEFAULT '',
      path TEXT,
      line INTEGER,
      diff_hunk TEXT,
      body TEXT NOT NULL DEFAULT '',
      user TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      url TEXT,
      type TEXT NOT NULL DEFAULT 'inline',
      status TEXT NOT NULL DEFAULT 'new',
      analysis_category TEXT,
      analysis_reasoning TEXT,
      fix_files_changed TEXT,
      fix_commit_hash TEXT,
      fix_commit_message TEXT,
      fix_fixed_at TEXT,
      seen_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (repo, id)
    );

    CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments (repo, pr_number);
    CREATE INDEX IF NOT EXISTS idx_comments_status ON comments (status);

    CREATE TABLE IF NOT EXISTS prs (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      review_cycle INTEGER NOT NULL DEFAULT 0,
      confidence_score INTEGER,
      phase TEXT NOT NULL DEFAULT 'polled',
      last_fixed_at TEXT,
      last_re_review_at TEXT,
      fix_results TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (repo, pr_number)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_poll_at TEXT
    );

    INSERT OR IGNORE INTO poll_state (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      reviewer_id TEXT NOT NULL,
      confidence_score REAL,
      summary TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      github_review_id TEXT,
      raw_output TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo, pr_number, reviewer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews (repo, pr_number);
  `);

  // Add run_history column if missing
  try {
    db.exec("ALTER TABLE prs ADD COLUMN run_history TEXT NOT NULL DEFAULT '[]'");
  } catch {
    // Column already exists
  }

  // Add replied_at column if missing
  try {
    db.exec("ALTER TABLE comments ADD COLUMN replied_at TEXT");
  } catch {
    // Column already exists
  }

  // Add reply_body column if missing
  try {
    db.exec("ALTER TABLE comments ADD COLUMN reply_body TEXT");
  } catch {
    // Column already exists
  }

  // Add deleted_at column for soft delete
  try {
    db.exec("ALTER TABLE repos ADD COLUMN deleted_at TEXT");
  } catch {
    // Column already exists
  }

  // Migrate reviews table to have UNIQUE constraint on (repo, pr_number, reviewer_id).
  // If the old table exists without the constraint, recreate it.
  try {
    // Check if the unique constraint exists by trying a conflicting insert
    const hasConstraint = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'",
    ).get() as { sql: string } | undefined;
    if (hasConstraint && !hasConstraint.sql.includes("UNIQUE")) {
      db.exec("DROP TABLE reviews");
      db.exec(`
        CREATE TABLE reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          reviewer_id TEXT NOT NULL,
          confidence_score REAL,
          summary TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          github_review_id TEXT,
          raw_output TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (repo, pr_number, reviewer_id)
        );
        CREATE INDEX idx_reviews_pr ON reviews (repo, pr_number);
      `);
      console.log("Migrated reviews table to add UNIQUE constraint");
    }
  } catch {
    // Table might not exist yet (handled by CREATE TABLE IF NOT EXISTS above)
  }
}

// ------- Migration from state.json -------

export function migrateFromJson(): void {
  const jsonPath = path.join(import.meta.dirname, "../../data/state.json");
  if (!fs.existsSync(jsonPath)) return;

  const db = getDB();
  // Check if we already migrated (repos table has data)
  const count = db.prepare("SELECT COUNT(*) as c FROM repos").get() as { c: number };
  if (count.c > 0) return;

  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const state = JSON.parse(raw);

    const insertRepo = db.prepare(
      "INSERT OR IGNORE INTO repos (label, owner, repo, bot_users, local_path) VALUES (?, ?, ?, ?, ?)",
    );
    const insertComment = db.prepare(`
      INSERT OR IGNORE INTO comments
        (id, repo, pr_number, pr_title, pr_url, status, analysis_category, analysis_reasoning,
         fix_files_changed, fix_commit_hash, fix_commit_message, fix_fixed_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPR = db.prepare(`
      INSERT OR IGNORE INTO prs
        (repo, pr_number, review_cycle, confidence_score, phase, last_fixed_at, last_re_review_at, fix_results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      // Repos
      for (const r of state.repos ?? []) {
        insertRepo.run(r.label, r.owner, r.repo, JSON.stringify(r.botUsers), r.localPath ?? null);
      }

      // Comments (state.json only has state, not full comment data — that's ok)
      for (const [_key, c] of Object.entries(state.comments ?? {})) {
        const cs = c as CommentState;
        insertComment.run(
          cs.commentId,
          cs.repo,
          cs.prNumber,
          "", // pr_title not stored in old state
          "", // pr_url not stored in old state
          cs.status,
          cs.analysis?.category ?? null,
          cs.analysis?.reasoning ?? null,
          cs.fixResult?.filesChanged ? JSON.stringify(cs.fixResult.filesChanged) : null,
          cs.fixResult?.commitHash ?? null,
          cs.fixResult?.commitMessage ?? null,
          cs.fixResult?.fixedAt ?? null,
          cs.seenAt,
        );
      }

      // PRs
      for (const [_key, p] of Object.entries(state.prs ?? {})) {
        const ps = p as PRState;
        insertPR.run(
          ps.repo,
          ps.prNumber,
          ps.reviewCycle,
          ps.confidenceScore,
          ps.phase,
          ps.lastFixedAt,
          ps.lastReReviewAt,
          JSON.stringify(ps.fixResults),
        );
      }

      // Settings
      if (state.settings) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
          "autoReReview",
          String(state.settings.autoReReview ?? false),
        );
      }

      // Last poll
      if (state.lastPollAt) {
        db.prepare("UPDATE poll_state SET last_poll_at = ? WHERE id = 1").run(state.lastPollAt);
      }
    });

    tx();
    console.log("Migrated state.json to SQLite");
  } catch (err) {
    console.error("Failed to migrate state.json:", err);
  }
}

// ------- Repos -------

export function getRepos(): RepoConfig[] {
  const rows = getDB()
    .prepare("SELECT label, owner, repo, bot_users, local_path FROM repos WHERE deleted_at IS NULL")
    .all() as Array<{ label: string; owner: string; repo: string; bot_users: string; local_path: string | null }>;

  return rows.map((r) => ({
    label: r.label,
    owner: r.owner,
    repo: r.repo,
    botUsers: JSON.parse(r.bot_users) as string[],
    ...(r.local_path ? { localPath: r.local_path } : {}),
  }));
}

export function getRepo(label: string): RepoConfig | null {
  const r = getDB()
    .prepare("SELECT label, owner, repo, bot_users, local_path FROM repos WHERE label = ? AND deleted_at IS NULL")
    .get(label) as { label: string; owner: string; repo: string; bot_users: string; local_path: string | null } | undefined;

  if (!r) return null;
  return {
    label: r.label,
    owner: r.owner,
    repo: r.repo,
    botUsers: JSON.parse(r.bot_users) as string[],
    ...(r.local_path ? { localPath: r.local_path } : {}),
  };
}

export function addRepo(owner: string, repo: string, localPath?: string): RepoConfig {
  const label = `${owner}/${repo}`;
  const existing = getRepo(label);
  if (existing) return existing;

  // Check for soft-deleted repo and restore it
  const db = getDB();
  const deleted = db
    .prepare("SELECT label, owner, repo, bot_users, local_path FROM repos WHERE label = ? AND deleted_at IS NOT NULL")
    .get(label) as { label: string; owner: string; repo: string; bot_users: string; local_path: string | null } | undefined;

  if (deleted) {
    db.prepare("UPDATE repos SET deleted_at = NULL, local_path = COALESCE(?, local_path) WHERE label = ?")
      .run(localPath ?? null, label);
    return {
      owner: deleted.owner,
      repo: deleted.repo,
      label: deleted.label,
      botUsers: JSON.parse(deleted.bot_users) as string[],
      localPath: localPath ?? deleted.local_path ?? undefined,
    };
  }

  const botUsers = [...DEFAULT_BOT_USERS];
  db.prepare("INSERT INTO repos (label, owner, repo, bot_users, local_path) VALUES (?, ?, ?, ?, ?)")
    .run(label, owner, repo, JSON.stringify(botUsers), localPath ?? null);

  return { owner, repo, label, botUsers, ...(localPath ? { localPath } : {}) };
}

export function removeRepo(label: string): void {
  getDB()
    .prepare("UPDATE repos SET deleted_at = ? WHERE label = ?")
    .run(new Date().toISOString(), label);
}

export function hardRemoveRepo(label: string): void {
  const db = getDB();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM comments WHERE repo = ?").run(label);
    db.prepare("DELETE FROM prs WHERE repo = ?").run(label);
    db.prepare("DELETE FROM reviews WHERE repo = ?").run(label);
    db.prepare("DELETE FROM repos WHERE label = ?").run(label);
  });
  tx();
}

export function updateRepoLocalPath(label: string, localPath: string | null): RepoConfig | null {
  const db = getDB();
  db.prepare("UPDATE repos SET local_path = ? WHERE label = ?").run(localPath, label);
  return getRepo(label);
}

// ------- Comments -------

export interface DBComment {
  id: number;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  body: string;
  user: string;
  createdAt: string;
  url: string | null;
  type: "inline" | "review" | "issue_comment";
  status: string;
  analysis: { commentId: number; category: string; reasoning: string } | null;
  fixResult: FixResult | null;
  repliedAt: string | null;
  replyBody: string | null;
}

function rowToDBComment(row: Record<string, unknown>): DBComment {
  return {
    id: row.id as number,
    repo: row.repo as string,
    prNumber: row.pr_number as number,
    prTitle: row.pr_title as string,
    prUrl: row.pr_url as string,
    path: row.path as string | null,
    line: row.line as number | null,
    diffHunk: row.diff_hunk as string | null,
    body: row.body as string,
    user: row.user as string,
    createdAt: row.created_at as string,
    url: row.url as string | null,
    type: row.type as "inline" | "review" | "issue_comment",
    status: row.status as string,
    analysis: row.analysis_category
      ? {
          commentId: row.id as number,
          category: row.analysis_category as string,
          reasoning: (row.analysis_reasoning as string) ?? "",
        }
      : null,
    fixResult: row.fix_commit_hash
      ? {
          commentId: row.id as number,
          filesChanged: row.fix_files_changed ? (JSON.parse(row.fix_files_changed as string) as string[]) : [],
          commitHash: row.fix_commit_hash as string,
          commitMessage: (row.fix_commit_message as string) ?? "",
          fixedAt: (row.fix_fixed_at as string) ?? "",
        }
      : null,
    repliedAt: (row.replied_at as string) ?? null,
    replyBody: (row.reply_body as string) ?? null,
  };
}

export function getCommentsByPR(repo: string, prNumber: number): DBComment[] {
  const rows = getDB()
    .prepare("SELECT * FROM comments WHERE repo = ? AND pr_number = ?")
    .all(repo, prNumber) as Record<string, unknown>[];

  return rows.map(rowToDBComment);
}

export function getCommentAsBotComment(repo: string, commentId: number): BotComment | null {
  const row = getDB()
    .prepare("SELECT * FROM comments WHERE repo = ? AND id = ?")
    .get(repo, commentId) as Record<string, unknown> | undefined;

  if (!row) return null;
  const c = rowToDBComment(row);
  return {
    id: c.id,
    prNumber: c.prNumber,
    prTitle: c.prTitle,
    prUrl: c.prUrl,
    repo: c.repo,
    path: c.path,
    line: c.line,
    diffHunk: c.diffHunk,
    body: c.body,
    user: c.user,
    createdAt: c.createdAt,
    url: c.url,
    type: c.type,
  };
}

/**
 * Upsert comments fetched from GitHub.
 * Updates content fields but preserves local state (status, analysis, fix) for existing comments.
 */
export function upsertGitHubComments(comments: BotComment[]): { newCount: number } {
  const db = getDB();
  let newCount = 0;

  const upsert = db.prepare(`
    INSERT INTO comments (id, repo, pr_number, pr_title, pr_url, path, line, diff_hunk, body, user, created_at, url, type, status, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
    ON CONFLICT (repo, id) DO UPDATE SET
      pr_title = excluded.pr_title,
      pr_url = excluded.pr_url,
      path = excluded.path,
      line = excluded.line,
      diff_hunk = excluded.diff_hunk,
      body = excluded.body,
      user = excluded.user,
      created_at = excluded.created_at,
      url = excluded.url,
      type = excluded.type
  `);

  const checkExists = db.prepare("SELECT 1 FROM comments WHERE repo = ? AND id = ?");

  const tx = db.transaction(() => {
    for (const c of comments) {
      const exists = checkExists.get(c.repo, c.id);
      if (!exists) newCount++;
      upsert.run(
        c.id,
        c.repo,
        c.prNumber,
        c.prTitle,
        c.prUrl,
        c.path,
        c.line,
        c.diffHunk,
        c.body,
        c.user,
        c.createdAt,
        c.url,
        c.type,
        new Date().toISOString(),
      );
    }
  });
  tx();

  return { newCount };
}

export function resetStaleFixing(): void {
  const db = getDB();
  // Reset stale "analyzing" comments: if they have analysis data, restore to "analyzed"; otherwise "new"
  const resetAnalyzingWithData = db.prepare(
    "UPDATE comments SET status = 'analyzed' WHERE status = 'analyzing' AND analysis_category IS NOT NULL",
  );
  const withDataResult = resetAnalyzingWithData.run();
  if (withDataResult.changes > 0) {
    console.log(`Restored ${withDataResult.changes} analyzed comment(s) from "analyzing" to "analyzed"`);
  }
  const resetAnalyzingNew = db.prepare(
    "UPDATE comments SET status = 'new' WHERE status = 'analyzing' AND analysis_category IS NULL",
  );
  const newResult = resetAnalyzingNew.run();
  if (newResult.changes > 0) {
    console.log(`Reset ${newResult.changes} stale comment(s) from "analyzing" to "new"`);
  }
  const reset = db.prepare("UPDATE comments SET status = 'analyzed' WHERE status = 'fixing'");
  const result = reset.run();
  if (result.changes > 0) {
    console.log(`Reset ${result.changes} stale comment(s) from "fixing" to "analyzed"`);
  }
  const resetPRs = db.prepare("UPDATE prs SET phase = 'analyzed' WHERE phase = 'fixing'");
  const prResult = resetPRs.run();
  if (prResult.changes > 0) {
    console.log(`Reset ${prResult.changes} stale PR(s) from "fixing" to "analyzed"`);
  }
}

export function updateCommentStatus(repo: string, commentId: number, status: string): void {
  getDB()
    .prepare("UPDATE comments SET status = ? WHERE repo = ? AND id = ?")
    .run(status, repo, commentId);
}

export function reopenComment(repo: string, commentId: number): void {
  getDB()
    .prepare(
      "UPDATE comments SET status = 'new', analysis_category = NULL, analysis_reasoning = NULL WHERE repo = ? AND id = ?",
    )
    .run(repo, commentId);
}

export function updateCommentCategory(repo: string, commentId: number, category: string): void {
  getDB()
    .prepare(
      "UPDATE comments SET status = 'analyzed', analysis_category = ? WHERE repo = ? AND id = ?",
    )
    .run(category, repo, commentId);
}

export function updateCommentAnalysis(repo: string, commentId: number, analysis: AnalysisResult): void {
  getDB()
    .prepare(
      "UPDATE comments SET status = 'analyzed', analysis_category = ?, analysis_reasoning = ? WHERE repo = ? AND id = ?",
    )
    .run(analysis.category, analysis.reasoning, repo, commentId);
}

export function revertCommentFix(repo: string, commitHash: string): number {
  const result = getDB()
    .prepare(
      `UPDATE comments SET status = 'analyzed',
        fix_files_changed = NULL, fix_commit_hash = NULL, fix_commit_message = NULL, fix_fixed_at = NULL
       WHERE repo = ? AND fix_commit_hash = ?`,
    )
    .run(repo, commitHash);
  return result.changes;
}

export function markCommentReplied(repo: string, commentId: number, replyBody?: string): void {
  getDB()
    .prepare("UPDATE comments SET replied_at = ?, reply_body = ? WHERE repo = ? AND id = ?")
    .run(new Date().toISOString(), replyBody ?? null, repo, commentId);
}

export function updateCommentFix(repo: string, commentId: number, fixResult: FixResult): void {
  getDB()
    .prepare(
      `UPDATE comments SET status = 'fixed',
        fix_files_changed = ?, fix_commit_hash = ?, fix_commit_message = ?, fix_fixed_at = ?
       WHERE repo = ? AND id = ?`,
    )
    .run(
      JSON.stringify(fixResult.filesChanged),
      fixResult.commitHash,
      fixResult.commitMessage,
      fixResult.fixedAt,
      repo,
      commentId,
    );
}

export function getUnanalyzedComments(repo: string, prNumber: number): BotComment[] {
  const rows = getDB()
    .prepare("SELECT * FROM comments WHERE repo = ? AND pr_number = ? AND status IN ('new', 'analyzing')")
    .all(repo, prNumber) as Record<string, unknown>[];

  return rows.map(rowToDBComment).map(dbCommentToBotComment);
}

export function getFixableComments(
  repo: string,
  prNumber: number,
  commentIds?: number[],
): BotComment[] {
  let rows: Record<string, unknown>[];
  if (commentIds && commentIds.length > 0) {
    // When specific IDs are given, allow any analyzed category (user explicitly chose these)
    const placeholders = commentIds.map(() => "?").join(",");
    rows = getDB()
      .prepare(
        `SELECT * FROM comments WHERE repo = ? AND pr_number = ?
         AND status IN ('analyzed', 'fix_failed')
         AND id IN (${placeholders})`,
      )
      .all(repo, prNumber, ...commentIds) as Record<string, unknown>[];
  } else {
    rows = getDB()
      .prepare(
        `SELECT * FROM comments WHERE repo = ? AND pr_number = ?
         AND status IN ('analyzed', 'fix_failed')
         AND analysis_category IN ('MUST_FIX', 'SHOULD_FIX')`,
      )
      .all(repo, prNumber) as Record<string, unknown>[];
  }

  return rows.map(rowToDBComment).map(dbCommentToBotComment);
}

function dbCommentToBotComment(c: DBComment): BotComment {
  return {
    id: c.id,
    prNumber: c.prNumber,
    prTitle: c.prTitle,
    prUrl: c.prUrl,
    repo: c.repo,
    path: c.path,
    line: c.line,
    diffHunk: c.diffHunk,
    body: c.body,
    user: c.user,
    createdAt: c.createdAt,
    url: c.url,
    type: c.type,
  };
}

export function getCommentStatesForFix(repo: string, commentIds: number[]): CommentState[] {
  const placeholders = commentIds.map(() => "?").join(",");
  const rows = getDB()
    .prepare(
      `SELECT * FROM comments WHERE repo = ? AND id IN (${placeholders})`,
    )
    .all(repo, ...commentIds) as Record<string, unknown>[];

  return rows.map(rowToDBComment).map((c) => ({
    commentId: c.id,
    repo: c.repo,
    prNumber: c.prNumber,
    status: c.status as CommentState["status"],
    analysis: c.analysis
      ? { commentId: c.id, category: c.analysis.category as AnalysisResult["category"], reasoning: c.analysis.reasoning }
      : undefined,
    fixResult: c.fixResult ?? undefined,
    seenAt: c.createdAt,
  }));
}

// ------- PRs -------

export function getPRState(repo: string, prNumber: number): PRState | undefined {
  const row = getDB()
    .prepare("SELECT * FROM prs WHERE repo = ? AND pr_number = ?")
    .get(repo, prNumber) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return {
    repo: row.repo as string,
    prNumber: row.pr_number as number,
    reviewCycle: row.review_cycle as number,
    confidenceScore: row.confidence_score as number | null,
    phase: row.phase as PRPhase,
    lastFixedAt: row.last_fixed_at as string | null,
    lastReReviewAt: row.last_re_review_at as string | null,
    fixResults: JSON.parse((row.fix_results as string) || "[]") as FixResult[],
  };
}

export function upsertPRState(pr: PRState): void {
  getDB()
    .prepare(
      `INSERT INTO prs (repo, pr_number, review_cycle, confidence_score, phase, last_fixed_at, last_re_review_at, fix_results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, pr_number) DO UPDATE SET
         review_cycle = excluded.review_cycle,
         confidence_score = excluded.confidence_score,
         phase = excluded.phase,
         last_fixed_at = excluded.last_fixed_at,
         last_re_review_at = excluded.last_re_review_at,
         fix_results = excluded.fix_results`,
    )
    .run(
      pr.repo,
      pr.prNumber,
      pr.reviewCycle,
      pr.confidenceScore,
      pr.phase,
      pr.lastFixedAt,
      pr.lastReReviewAt,
      JSON.stringify(pr.fixResults),
    );
}

// ------- Run History -------

export function getRunHistory(repo: string, prNumber: number): unknown[] {
  const row = getDB()
    .prepare("SELECT run_history FROM prs WHERE repo = ? AND pr_number = ?")
    .get(repo, prNumber) as { run_history: string } | undefined;
  if (!row) return [];
  return JSON.parse(row.run_history || "[]") as unknown[];
}

export function appendRunHistory(repo: string, prNumber: number, entry: unknown): void {
  const current = getRunHistory(repo, prNumber);
  current.push(entry);
  // Keep last 20 runs
  const trimmed = current.slice(-20);
  getDB()
    .prepare("UPDATE prs SET run_history = ? WHERE repo = ? AND pr_number = ?")
    .run(JSON.stringify(trimmed), repo, prNumber);
}

// ------- Settings -------

export function getSettings(): AppSettings {
  const row = getDB()
    .prepare("SELECT value FROM settings WHERE key = 'autoReReview'")
    .get() as { value: string } | undefined;

  return {
    autoReReview: row?.value === "true",
  };
}

export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const db = getDB();
  if (updates.autoReReview !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('autoReReview', ?)").run(
      String(updates.autoReReview),
    );
  }
  return getSettings();
}

// ------- Poll -------

export function getLastPollAt(): string | null {
  const row = getDB()
    .prepare("SELECT last_poll_at FROM poll_state WHERE id = 1")
    .get() as { last_poll_at: string | null } | undefined;
  return row?.last_poll_at ?? null;
}

export function updateLastPoll(): void {
  getDB()
    .prepare("UPDATE poll_state SET last_poll_at = ? WHERE id = 1")
    .run(new Date().toISOString());
}

// ------- Summary -------

export function getSummary(): {
  repos: number;
  totalComments: number;
  lastPollAt: string | null;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
} {
  const db = getDB();

  const repoCount = (db.prepare("SELECT COUNT(*) as c FROM repos").get() as { c: number }).c;
  const totalComments = (db.prepare("SELECT COUNT(*) as c FROM comments").get() as { c: number }).c;

  const statusRows = db
    .prepare("SELECT status, COUNT(*) as c FROM comments GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  const byStatus: Record<string, number> = {
    new: 0, analyzing: 0, analyzed: 0, fixing: 0, fixed: 0, fix_failed: 0, dismissed: 0,
  };
  for (const r of statusRows) byStatus[r.status] = r.c;

  const catRows = db
    .prepare("SELECT analysis_category, COUNT(*) as c FROM comments WHERE analysis_category IS NOT NULL GROUP BY analysis_category")
    .all() as Array<{ analysis_category: string; c: number }>;
  const byCategory: Record<string, number> = {};
  for (const r of catRows) byCategory[r.analysis_category] = r.c;

  return {
    repos: repoCount,
    totalComments,
    lastPollAt: getLastPollAt(),
    byStatus,
    byCategory,
  };
}

// ------- Cleanup stale comments -------

/**
 * Remove comments (and PR state) for PRs that are no longer open.
 */
export function cleanupClosedPRComments(repo: string, openPRNumbers: number[]): number {
  const db = getDB();
  if (openPRNumbers.length === 0) {
    // No open PRs could mean a GitHub API failure — skip cleanup to avoid deleting valid data
    return 0;
  }

  const placeholders = openPRNumbers.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM comments WHERE repo = ? AND pr_number NOT IN (${placeholders})`)
    .run(repo, ...openPRNumbers);
  db.prepare(`DELETE FROM prs WHERE repo = ? AND pr_number NOT IN (${placeholders})`)
    .run(repo, ...openPRNumbers);
  db.prepare(`DELETE FROM reviews WHERE repo = ? AND pr_number NOT IN (${placeholders})`)
    .run(repo, ...openPRNumbers);
  return result.changes;
}

// ------- Fixable count -------

export function getFixableCount(repo: string, prNumber: number): number {
  const row = getDB()
    .prepare(
      `SELECT COUNT(*) as c FROM comments
       WHERE repo = ? AND pr_number = ?
       AND status IN ('analyzed', 'fix_failed')
       AND analysis_category IN ('MUST_FIX', 'SHOULD_FIX')`,
    )
    .get(repo, prNumber) as { c: number };
  return row.c;
}

// ------- Reviews -------

/**
 * Upsert a review. If a review already exists for the same (repo, pr_number, reviewer_id),
 * update it instead of creating a duplicate. This handles Greptile updating the same
 * comment in-place with a new score.
 */
export function insertReview(review: Review): number {
  const result = getDB()
    .prepare(
      `INSERT INTO reviews (repo, pr_number, reviewer_id, confidence_score, summary, source, github_review_id, raw_output, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, pr_number, reviewer_id) DO UPDATE SET
         confidence_score = COALESCE(excluded.confidence_score, confidence_score),
         summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE summary END,
         github_review_id = COALESCE(excluded.github_review_id, github_review_id),
         raw_output = CASE WHEN excluded.raw_output != '' THEN excluded.raw_output ELSE raw_output END,
         updated_at = excluded.updated_at`,
    )
    .run(
      review.repo,
      review.prNumber,
      review.reviewerId,
      review.confidenceScore,
      review.summary,
      review.source,
      review.githubReviewId,
      review.rawOutput,
      review.createdAt,
      review.updatedAt,
    );
  return result.lastInsertRowid as number;
}

export function getReviewsByPR(repo: string, prNumber: number): Review[] {
  const rows = getDB()
    .prepare(
      "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC",
    )
    .all(repo, prNumber) as Array<Record<string, unknown>>;

  return rows.map(rowToReview);
}

export function getLatestReview(
  repo: string,
  prNumber: number,
  reviewerId: ReviewerId,
): Review | null {
  const row = getDB()
    .prepare(
      "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? AND reviewer_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(repo, prNumber, reviewerId) as Record<string, unknown> | undefined;

  return row ? rowToReview(row) : null;
}

export function getLatestReviewPerReviewer(
  repo: string,
  prNumber: number,
): Review[] {
  // With UNIQUE(repo, pr_number, reviewer_id), there's exactly one row per reviewer
  const rows = getDB()
    .prepare(
      "SELECT * FROM reviews WHERE repo = ? AND pr_number = ?",
    )
    .all(repo, prNumber) as Array<Record<string, unknown>>;

  return rows.map(rowToReview);
}

function rowToReview(row: Record<string, unknown>): Review {
  return {
    id: row.id as number,
    repo: row.repo as string,
    prNumber: row.pr_number as number,
    reviewerId: row.reviewer_id as ReviewerId,
    confidenceScore: row.confidence_score as number | null,
    summary: row.summary as string | null,
    source: row.source as "remote" | "local",
    githubReviewId: row.github_review_id as string | null,
    rawOutput: row.raw_output as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
