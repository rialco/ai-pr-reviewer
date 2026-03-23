# Cloud Migration Plan

## Goal

Move this project from a single local-process architecture to a split architecture:

- `Clerk` handles user authentication and workspace identity.
- `Convex` becomes the cloud control plane and source of truth.
- Local machines remain the execution plane for `git`, `gh`, `claude`, `codex`, worktrees, and repository access.

This keeps the app accessible anywhere while preserving local subscriptions and local execution.

## Workflow Changes

### Before

- One local Express process owns state, polling, fixing, and orchestration.
- GitHub identity is whichever account is logged into `gh` on the active machine.
- The UI polls local REST endpoints for changes.

### After

- The browser signs into Clerk and reads cloud state from Convex.
- Convex stores repos, PR state, comments, timeline, jobs, and machine availability.
- Machines connect as workers, report health, and claim work.
- The browser becomes realtime through Convex subscriptions instead of local polling.
- Execution still happens on linked computers, not inside Convex.

## GitHub Identity Model

Recommended split:

- Use a stable cloud-side GitHub integration for visibility and sync.
- Use the local machine identity for workstation-bound actions like local checkout, commit, push, and optional comment/review posting.

This avoids tying visibility to whichever machine currently runs `gh pr list --author @me`.

## Why `localPath` Must Change

The current repo config stores one machine-local path per repo. That does not survive a cloud move.

The new model must be:

- `repo`: cloud record shared by the workspace.
- `repoMachineConfig`: per-machine checkout path and per-machine execution settings.

## Machine Model

Each machine should eventually have:

- Stable machine slug and display name.
- Workspace enrollment flow.
- Heartbeat and status updates.
- Capability report for `git`, `gh`, `claude`, and `codex`.
- Job claiming with lease renewal.
- Run logs streamed back into Convex.

## Phase Breakdown

### Phase 1

- Add Clerk and Convex scaffolding.
- Add Convex schema for users, workspaces, repos, machines, PRs, comments, and jobs.
- Gate the UI with Clerk while preserving legacy local mode when env vars are missing.
- Add a worker scaffold that makes the local execution plane explicit.

### Phase 2

- Initialize a real Convex project and generate `convex/_generated`.
- Replace generic Convex function wrappers with generated typed wrappers.
- Add authenticated workspace bootstrap in the UI.
- Introduce workspace-aware repo management in Convex.

### Phase 3

- Implement machine enrollment and authenticated heartbeats.
- Build the machine job-claiming protocol.
- Move activity feed and coordinator state to Convex.

### Phase 4

- Replace local REST polling with Convex subscriptions for repos, jobs, and machines.
- Move local-path management from the Express backend to machine-bound configuration.

### Phase 5

- Rework GitHub sync around a durable identity model.
- Decide which actions post as the user versus a bot/app identity.

## Current Branch Status

This branch intentionally keeps the existing Express app usable while the cloud control plane is introduced in parallel.

That means:

- The old local REST workflow still exists.
- The new Convex data model is present but not initialized in a deployment yet.
- Worker enrollment and secure machine auth are still pending.

## Immediate Next Steps

1. Create or link a Convex deployment with `pnpm convex:dev`.
2. Configure Clerk and set the values from `.env.example`.
3. Generate `convex/_generated`.
4. Replace generic Convex wrappers with generated ones.
5. Wire the signed-in UI to `bootstrap.viewer`, `workspaces.listForCurrentUser`, and workspace repo queries.
