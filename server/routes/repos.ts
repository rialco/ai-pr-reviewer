import { Router } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { getRepos, addRepo, removeRepo, hardRemoveRepo, updateRepoLocalPath, getSettings, updateSettings } from "../services/db.js";
import type { AppSettings } from "../types.js";

const router = Router();

router.get("/", (_req, res) => {
  res.json(getRepos());
});

router.post("/", (req, res) => {
  const { owner, repo, localPath } = req.body as { owner: string; repo: string; localPath?: string };
  if (!owner || !repo) {
    res.status(400).json({ error: "owner and repo required" });
    return;
  }
  const config = addRepo(owner, repo, localPath);
  res.json(config);
});

// Settings
router.get("/settings", (_req, res) => {
  res.json(getSettings());
});

router.patch("/settings", (req, res) => {
  const updates = req.body as Partial<AppSettings>;
  const settings = updateSettings(updates);
  res.json(settings);
});

router.patch("/:label", (req, res) => {
  const label = decodeURIComponent(req.params.label);
  const { localPath } = req.body as { localPath?: string | null };
  const updated = updateRepoLocalPath(label, localPath ?? null);
  if (!updated) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:label", (req, res) => {
  const label = decodeURIComponent(req.params.label);
  const hard = req.query.hard === "true";
  if (hard) {
    hardRemoveRepo(label);
  } else {
    removeRepo(label);
  }
  res.json({ ok: true });
});

// Extract owner/repo from a local git repo's remote
router.get("/browse/git-remote", (req, res) => {
  const requestedPath = (req.query.path as string) || "";
  if (!requestedPath) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const resolved = requestedPath.startsWith("~")
    ? path.join(os.homedir(), requestedPath.slice(1))
    : path.resolve(requestedPath);

  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: resolved,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    // Parse owner/repo from various remote URL formats:
    // git@github.com:owner/repo.git
    // https://github.com/owner/repo.git
    // https://github.com/owner/repo
    const match = remoteUrl.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
      res.status(400).json({ error: "Could not parse remote URL: " + remoteUrl });
      return;
    }
    res.json({ owner: match[1], repo: match[2], remoteUrl });
  } catch {
    res.status(400).json({ error: "Not a git repo or no origin remote" });
  }
});

// Browse directories for local path picker
router.get("/browse", (req, res) => {
  const requestedPath = (req.query.path as string) || os.homedir();
  const resolved = requestedPath.startsWith("~")
    ? path.join(os.homedir(), requestedPath.slice(1))
    : path.resolve(requestedPath);

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Not a directory" });
      return;
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    // Check if this directory is a git repo
    const isGitRepo = fs.existsSync(path.join(resolved, ".git"));

    res.json({
      current: resolved,
      parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
      dirs,
      isGitRepo,
    });
  } catch {
    res.status(400).json({ error: `Cannot read directory: ${resolved}` });
  }
});

export default router;
