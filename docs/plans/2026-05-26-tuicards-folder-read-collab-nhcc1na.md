---
planId: plan_nhcc1na
owner: claude
participants:
  - claude
  - codex
status: planned
createdAt: 2026-05-26T10:40:34.418Z
---

# tuicards-folder-read-collab

## Goal

Have Claude and Codex each read tui/src/components/tuicards/ and exchange a brief inventory + observations, exercising the collab tooling end-to-end.

## Scope

Read-only. No file edits. Each agent inspects only tui/src/components/tuicards/ and reports back via collab messages.

## Phases

1. Claude inventory: list the files in tui/src/components/tuicards/ and summarize what index.ts re-exports.
2. Codex cross-check: independently list the same folder and describe the primitives in parts.tsx and the shape of types.ts.
3. Joint reconciliation: Claude composes a short combined summary and notes any disagreement between the two reads.

## Risks

1. Either runner could over-read (touch files outside tuicards/) — keep prompts tight.
2. Codex turn could time out; use a short timeoutSec and a narrow request.

## Verification

1. Each phase has a phase_summary on the collab thread.
2. collab_finish is called with a summary that names the file count and lists at least three exported components.
