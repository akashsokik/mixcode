---
planId: plan_wd9jiwua
owner: claude
participants:
  - claude
  - codex
status: planned
createdAt: 2026-05-26T09:54:14.731Z
---

# collab smoke roundtrip

## Goal

Smoke-test the Claude↔Codex collaboration workflow end-to-end: shared plan → bounded peer turn → phase transitions → finish.

## Scope

No code changes. Exercise orchestrator collab tools only.

## Phases

1. Claude drafts plan and opens collab
2. Codex reviews plan and proposes one tiny improvement
3. Claude records decision and finishes

## Risks

1. Peer timeout if codex runner unavailable
2. Phase IDs misaligned between plan and collab state

## Verification

1. plan_read returns the plan markdown
2. collab_observe shows >=1 peerTurn and >=1 decision
3. collab_finish returns status=completed
