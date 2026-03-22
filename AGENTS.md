# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## Commands

```bash
pnpm dev              # Run server + UI concurrently (server on :3847, UI on :5173)
pnpm dev:server       # Server only (tsx watch server/index.ts)
pnpm dev:ui           # Vite dev server only
pnpm build            # Production build (vite build)
pnpm typecheck        # Type check with tsc --noEmit
```

No test framework or linter is configured.

## Architecture

Full-stack TypeScript app that tracks GitHub PR review comments, analyzes them with Claude CLI/Codex CLI, and can auto-fix issues.

**Stack**: React 19 + Vite 8 + Tailwind CSS 4 (frontend), Express 5 + SQLite (backend), pnpm package manager.

### Backend (`server/`)

- **Entry**: `server/index.ts` — Express server on port 3847
- **Routes**: `server/routes/` — `repos.ts` (CRUD repos), `prs.ts` (PR analysis/fix workflow), `reviews.ts` (AI review requests)
- **Services**: `server/services/` — Core logic: `db.ts` (SQLite schema + queries), `github.ts` (wraps `gh` CLI), `analyzer.ts` (AGENT CLI invocation), `fixer.ts` (git operations + code fixes), `poller.ts` (5-min background sync), `jobs.ts` (activity tracking)
- **Domain**: `server/domain/review/` — DDD ports & adapters pattern. `ReviewerPort.ts` defines the interface; `ReviewService.ts` orchestrates reviewers
- **Infrastructure**: `server/infrastructure/reviewers/` — Adapter implementations: `GreptileReviewer` (extracts from GH comments), `ClaudeReviewer` (local CLI), `CodexReviewer` (local model). `registry.ts` is a singleton service locator

### Frontend (`src/`)

- **Root**: `src/App.tsx` — 3-pane layout (repos, PR list, comment view)
- **Hooks**: `src/hooks/useApi.ts` — All API fetch hooks using TanStack React Query. `useJobs.ts` — activity feed
- **Components**: `src/components/` — `CommentView.tsx` (main PR analysis UI), `PRList.tsx` (sidebar), `ReviewScoreboard.tsx` (scores display), `JobCenter.tsx` (real-time job tracker)
- **UI primitives**: `src/components/ui/` — Variant-based components using class-variance-authority

### Frontend Rules

- Prefer shadcn-style UI primitives in `src/components/ui/` for interactive controls instead of raw browser controls.
- For selects, menus, popovers, and similar composite widgets, use the local shadcn/Radix wrapper component before introducing a native `<select>` or custom one-off dropdown.
- Follow the shared design guidance in `docs/design-system.md` for color palette, component choices, section headers, hierarchy, and new UI decisions.

### Key Patterns

- **NDJSON streaming** for long-running ops (analysis, fixes, reviews). Server streams `{type, step, message, progress}` events; client parses incrementally
- **Async operations** return 202 Accepted, run in background, track progress via job system
- **Repo labels** (e.g. "owner/repo") are URL-encoded in route params — always `decodeURIComponent(req.params.repo)`
- **Path alias**: `@/*` maps to `./src/*` in both tsconfig and Vite
- **Vite proxy**: `/api/*` requests proxy to `http://localhost:3847` in dev

### Comment Lifecycle

```
new → [analyze via Claude CLI]/[analyze via Codex CLI] → analyzed (MUST_FIX|SHOULD_FIX|NICE_TO_HAVE|DISMISS|ALREADY_ADDRESSED) → [fix] → fixed → [reply on GitHub]
```

### External Dependencies

- **`gh` CLI** required — all GitHub operations go through it
- **`claude` CLI** optional — used for local analysis and reviews
- - **`codex` CLI** optional — used for local analysis and reviews
- **Local repo paths** — repos can have a `localPath` for file context during analysis/fixes
