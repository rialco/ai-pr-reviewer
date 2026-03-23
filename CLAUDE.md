# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev              # Run Convex + UI concurrently
pnpm dev:ui           # Vite dev server only
pnpm dev:worker       # Local worker only
pnpm convex:dev       # Convex dev deployment/codegen loop
pnpm build            # Production build (vite build)
pnpm typecheck        # Type check with tsc --noEmit
```

No test framework or linter is configured.

## Architecture

Cloud-backed TypeScript app that tracks GitHub PR review comments, coordinates local AI review/fix jobs, and runs those jobs on linked worker machines.

**Stack**: React 19 + Vite 8 + Tailwind CSS 4 (frontend), Clerk + Convex (cloud control plane), local worker runtime for git/gh/Claude/Codex execution, pnpm package manager.

### Cloud / Worker

- **Convex functions**: `convex/` — auth, repos, PR snapshots, reviews, machines, jobs, settings
- **Worker**: `worker/index.ts` — enrolls machines, heartbeats, claims jobs, runs local git/gh/Claude/Codex actions
- **Shared runtime logic**: `core/services/`, `core/infrastructure/reviewers/`, `core/domain/review/`, `core/types.ts` — imported by the worker for GitHub, analysis, review, and fix execution

### Frontend (`src/`)

- **Root**: `src/App.tsx` — 3-pane layout (repos, PR list, comment view)
- **Cloud UI**: `src/components/CloudAppShell.tsx`, `src/components/CloudCommentView.tsx`, `src/components/CloudJobCenter.tsx`
- **Sidebar flows**: `src/components/AddRepo.tsx`, `src/components/RepoList.tsx`, `src/components/PRList.tsx`
- **UI primitives**: `src/components/ui/` — Variant-based components using class-variance-authority

### Frontend Rules

- Prefer shadcn-style UI primitives in `src/components/ui/` for interactive controls instead of raw browser controls.
- For selects, menus, popovers, and similar composite widgets, use the local shadcn/Radix wrapper component before introducing a native `<select>` or custom one-off dropdown.
- Follow the shared design guidance in `docs/design-system.md` for color palette, component choices, section headers, hierarchy, and new UI decisions.

### Key Patterns

- **Cloud control plane**: Clerk authenticates users; Convex stores repos, PR snapshots, machines, reviews, jobs, and settings
- **Local execution plane**: workers claim Convex jobs and execute them with local `git`, `gh`, `claude`, and `codex`
- **Worker-driven repo onboarding**: the UI submits a checkout path probe to a selected machine instead of browsing the local filesystem through a web server
- **Path alias**: `@/*` maps to `./src/*` in both tsconfig and Vite

### Comment Lifecycle

```
new → [analyze via Claude CLI] → analyzed (MUST_FIX|SHOULD_FIX|NICE_TO_HAVE|DISMISS|ALREADY_ADDRESSED) → [fix] → fixed → [reply on GitHub]
```

### External Dependencies

- **`gh` CLI** required — all GitHub operations go through it
- **`claude` CLI** optional — used for local analysis and reviews
- **Local repo paths** — repos can have a `localPath` for file context during analysis/fixes
