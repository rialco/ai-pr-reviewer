import fs from "fs";
import path from "path";
import type { AppSettings, AppState, CommentState, PRState, RepoConfig } from "../types.js";
import { DEFAULT_BOT_USERS } from "../types.js";

const STATE_PATH = path.join(import.meta.dirname, "../../data/state.json");

const DEFAULT_SETTINGS: AppSettings = {
  autoReReview: false,
  coordinatorEnabled: false,
  coordinatorAgent: "claude",
  defaultAnalyzerAgent: "claude",
  defaultFixerAgent: "claude",
  defaultReviewerIds: ["claude", "codex"],
};

function defaultState(): AppState {
  return {
    repos: [],
    comments: {},
    prs: {},
    settings: { ...DEFAULT_SETTINGS },
    lastPollAt: null,
  };
}

export function loadState(): AppState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(raw) as AppState;
    // Ensure prs and settings exist for backwards compatibility
    if (!state.prs) state.prs = {};
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
    return state;
  } catch {
    return defaultState();
  }
}

export function saveState(state: AppState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function addRepo(owner: string, repo: string): RepoConfig {
  const state = loadState();
  const label = `${owner}/${repo}`;
  const existing = state.repos.find((r) => r.label === label);
  if (existing) return existing;

  const config: RepoConfig = {
    owner,
    repo,
    label,
    botUsers: [...DEFAULT_BOT_USERS],
  };
  state.repos.push(config);
  saveState(state);
  return config;
}

export function removeRepo(label: string): void {
  const state = loadState();
  state.repos = state.repos.filter((r) => r.label !== label);
  // Clean up comments for this repo
  for (const key of Object.keys(state.comments)) {
    if (key.startsWith(label + ":")) {
      delete state.comments[key];
    }
  }
  // Clean up PR states for this repo
  for (const key of Object.keys(state.prs)) {
    if (key.startsWith(label + ":")) {
      delete state.prs[key];
    }
  }
  saveState(state);
}

export function getCommentKey(repo: string, commentId: number): string {
  return `${repo}:${commentId}`;
}

export function getCommentState(
  repo: string,
  commentId: number,
): CommentState | undefined {
  const state = loadState();
  return state.comments[getCommentKey(repo, commentId)];
}

export function upsertCommentState(
  commentState: CommentState,
): void {
  const state = loadState();
  const key = getCommentKey(commentState.repo, commentState.commentId);
  state.comments[key] = commentState;
  saveState(state);
}

export function getPRKey(repo: string, prNumber: number): string {
  return `${repo}:${prNumber}`;
}

export function getPRState(
  repo: string,
  prNumber: number,
): PRState | undefined {
  const state = loadState();
  return state.prs[getPRKey(repo, prNumber)];
}

export function upsertPRState(prState: PRState): void {
  const state = loadState();
  const key = getPRKey(prState.repo, prState.prNumber);
  state.prs[key] = prState;
  saveState(state);
}

export function updateLastPoll(): void {
  const state = loadState();
  state.lastPollAt = new Date().toISOString();
  saveState(state);
}

export function getSettings(): AppSettings {
  return loadState().settings;
}

export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const state = loadState();
  state.settings = { ...state.settings, ...updates };
  saveState(state);
  return state.settings;
}

export function updateRepoLocalPath(label: string, localPath: string | null): RepoConfig | null {
  const state = loadState();
  const repo = state.repos.find((r) => r.label === label);
  if (!repo) return null;
  if (localPath) {
    repo.localPath = localPath;
  } else {
    delete repo.localPath;
  }
  saveState(state);
  return repo;
}
