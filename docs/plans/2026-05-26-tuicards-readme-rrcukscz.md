---
planId: plan_rrcukscz
owner: claude
participants:
  - claude
  - codex
status: planned
createdAt: 2026-05-26T10:35:50.133Z
---

# tuicards-readme

## Goal

Add a short README.md to tui/src/components/tuicards/ that explains what each module in the folder is for, so future contributors can navigate it without reading every file.

## Scope

Documentation only — no behavior changes. Touch only tui/src/components/tuicards/README.md.

## Phases

1. Phase 1 (Claude): Inventory the tuicards/ folder — list each file with a one-line summary of its responsibility, drafted from reading the actual source.
2. Phase 2 (Codex): Review the inventory for accuracy and gaps, suggest organization (grouping/order) and any missing context a newcomer would need.
3. Phase 3 (Claude): Write tui/src/components/tuicards/README.md incorporating the inventory and Codex's feedback.

## Risks

1. Inventory drifts from reality if files are skimmed instead of read
2. README becomes prescriptive instead of descriptive and ages poorly

## Verification

1. ls tui/src/components/tuicards/README.md
2. Verify every .tsx/.ts file in the folder is mentioned in the README
