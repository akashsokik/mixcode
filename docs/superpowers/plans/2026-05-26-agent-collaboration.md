# Agent Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded Claude <-> Codex collaboration workflow with shared repo-local plan files and explicit phased execution messages.

**Architecture:** Add a focused `server/src/orchestrator/collab.ts` module that owns plan files, in-memory collaboration runs, phase state, snapshots, and bounded peer calls via `startSubtaskRun`. Wire those helpers into the existing orchestrator MCP surfaces for Claude and Codex, using the existing `/internal/delegate` HTTP proxy for Codex. Keep the first TUI pass generic by emitting stable `tool_log` snapshots named `collab`.

**Tech Stack:** TypeScript, Node fs/path APIs, Hono internal endpoint, Anthropic in-process MCP wrapper, Codex stdio MCP proxy, `node:test` with `tsx`.

---

### Task 1: Collaboration Core

**Files:**
- Create: `server/src/orchestrator/collab.ts`
- Create: `server/src/orchestrator/collab.test.ts`

- [ ] Write failing tests for `plan_create`, `plan_read`, `collab_start`, phase transitions, message append, and snapshot emission.
- [ ] Run `npm --workspace server test -- src/orchestrator/collab.test.ts` and verify the tests fail because the module does not exist.
- [ ] Implement `collab.ts` with pure helpers plus injectable peer runner support for `collab_ask_peer`.
- [ ] Run the focused test and verify it passes.

### Task 2: MCP Tool Wiring

**Files:**
- Modify: `server/src/runners/delegate.ts`
- Modify: `server/src/modules/mcp-codex-orchestrator.mjs`
- Modify: `server/src/index.ts`

- [ ] Add Claude in-process tools: `plan_create`, `plan_read`, `collab_start`, `collab_send`, `collab_ask_peer`, `collab_observe`, `phase_start`, `phase_done`, `phase_handoff`, `collab_finish`, `collab_cancel`.
- [ ] Add Codex stdio proxy registrations for the same tools.
- [ ] Add `/internal/delegate` action cases that call the collaboration helpers.
- [ ] Register/unregister the collaboration snapshot emitter in `runTurn`.
- [ ] Clear/cancel collaboration state on session delete and clear.

### Task 3: Verification

**Files:**
- Modify as required by typecheck or tests.

- [ ] Run `npm --workspace server test`.
- [ ] Run `npm --workspace server run typecheck`.
- [ ] Inspect `git diff` for accidental unrelated changes.
