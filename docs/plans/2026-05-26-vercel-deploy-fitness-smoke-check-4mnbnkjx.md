---
planId: plan_4mnbnkjx
owner: claude
participants:
  - claude
  - codex
status: planned
createdAt: 2026-05-26T10:18:29.145Z
---

# Vercel deploy fitness smoke check

## Goal

Identify which workspaces in this monorepo could plausibly be deployed to Vercel and what would block them. Produce a short written note — no code changes, no deploy.

## Scope

Read-only inspection of repo layout, package.json, and existing build/deploy artifacts. No edits outside docs/plans/.

## Phases

1. Survey workspaces and list candidate deploy targets
2. Peer-review the survey for misses and blockers
3. Write a one-paragraph conclusion

## Risks

1. Peer may try to actually deploy
2. Survey may miss a workspace not at top level

## Verification

1. docs/plans/ file exists with planId
2. collab finishes with status=done
