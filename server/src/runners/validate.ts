// `validate_run` MCP tool — adversarial peer review of completed work.
//
// Sits on top of the existing peer-delegation rail. We do not duplicate
// transport, run-state tracking, peer-event forwarding, depth guards, or
// self-delegation guards. `executeValidate` builds an adversarial prompt,
// delegates through `executeDelegate`, then parses a trailing JSON verdict
// block from the peer's free-form result.
//
// Loop: task → validate_run → done. The calling agent reads the verdict and
// decides whether to keep working. No framework retry; agent-driven.
import { z } from "zod";
import type { RunnerKind } from "../../../shared/events.js";
import {
  executeDelegate,
  type DelegateExecCtx,
  type DelegateExecResult,
} from "./delegate.js";

export type ValidateExecArgs = {
  peer?: RunnerKind;
  claim: string;
  context?: string;
  files?: string[];
  focus?: string;
  timeoutSec: number;
};

// Per-arg server-side caps. The agent assembles `claim` / `context` itself, so
// nothing here is a security bound — just sanity ceilings to keep an
// over-eager agent from blowing the peer's context budget.
const CLAIM_MAX = 8_000;
const CONTEXT_MAX = 4_000;
const FOCUS_MAX = 2_000;
const FILES_MAX = 20;

const VERDICT_VALUES = ["pass", "fail", "needs_changes"] as const;
const SEVERITY_VALUES = ["high", "med", "low"] as const;

const VerdictSchema = z.object({
  verdict: z.enum(VERDICT_VALUES),
  summary: z.string(),
  issues: z
    .array(
      z.object({
        severity: z.enum(SEVERITY_VALUES),
        description: z.string(),
        location: z.string().nullable(),
      }),
    )
    .default([]),
});

export type ParsedVerdict =
  | {
      verdict: "pass" | "fail" | "needs_changes";
      summary: string;
      issues: Array<{
        severity: "high" | "med" | "low";
        description: string;
        location: string | null;
      }>;
      raw: string;
    }
  | {
      verdict: "unknown";
      summary: string;
      issues: [];
      raw: string;
      parseError: string;
    };

// Match the LAST fenced ```json ... ``` block in the peer's text. Anchored to
// end-of-string-ish so a model that "explains then emits" still parses.
const JSON_FENCE = /```json\s*([\s\S]*?)\s*```\s*$/i;

export function parseVerdict(raw: string): ParsedVerdict {
  const m = raw.match(JSON_FENCE);
  if (!m) {
    return {
      verdict: "unknown",
      summary: "validator did not emit a parseable verdict block",
      issues: [],
      raw,
      parseError: "no ```json fence found at end of response",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (err) {
    return {
      verdict: "unknown",
      summary: "validator emitted a JSON block that did not parse",
      issues: [],
      raw,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return {
      verdict: "unknown",
      summary: "validator JSON did not match expected schema",
      issues: [],
      raw,
      parseError: result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    };
  }
  return {
    verdict: result.data.verdict,
    summary: result.data.summary,
    issues: result.data.issues,
    raw,
  };
}

export function buildValidationPrompt(
  args: ValidateExecArgs,
  parentRunner: RunnerKind,
): string {
  const claim = args.claim.slice(0, CLAIM_MAX);
  const context = args.context?.slice(0, CONTEXT_MAX);
  const focus = args.focus?.slice(0, FOCUS_MAX);
  const files = (args.files ?? []).slice(0, FILES_MAX);

  const sections: string[] = [];
  sections.push(
    "You are an adversarial code reviewer. Another agent (the \"claimant\") has just",
    "completed work and claims it is done. Your job is to FIND PROBLEMS, not to",
    "agree. Read the actual repository state — do not trust the claim.",
    "",
    `CLAIMANT WAS: ${parentRunner}`,
    "CLAIMANT'S CLAIM:",
    claim,
  );
  if (context) {
    sections.push("", "BACKGROUND THE CLAIMANT PROVIDED:", context);
  }
  if (files.length > 0) {
    sections.push(
      "",
      "FILES THE CLAIMANT SAYS ARE RELEVANT:",
      files.join("\n"),
    );
  }
  if (focus) {
    sections.push("", "CLAIMANT FLAGGED FOR EXTRA SCRUTINY:", focus);
  }
  sections.push(
    "",
    "Your task:",
    "1. Use Read/Grep/Glob/Bash to verify the claim against the current repo state.",
    "2. Look for: unmet requirements, broken edge cases, missing tests, lint/type",
    "   errors, regressions, silent failures, security issues, dead code, TODOs.",
    "3. Be specific. \"It looks fine\" is not a review.",
    "",
    "DO NOT call delegate_run or validate_run. You are the terminal reviewer.",
    "",
    "End your response with EXACTLY this JSON block (and nothing after it):",
    "```json",
    "{\"verdict\":\"pass\"|\"fail\"|\"needs_changes\",\"summary\":\"...\",\"issues\":[{\"severity\":\"high\"|\"med\"|\"low\",\"description\":\"...\",\"location\":\"file:line or null\"}]}",
    "```",
    "- pass: claim is accurate, no blockers",
    "- needs_changes: real issues but direction is right",
    "- fail: claim is wrong or work is broken",
  );
  return sections.join("\n");
}

export type ValidateExecResult = DelegateExecResult;

export async function executeValidate(
  args: ValidateExecArgs,
  ctx: DelegateExecCtx,
): Promise<ValidateExecResult> {
  const peer: RunnerKind =
    args.peer ?? (ctx.parentRunner === "claude" ? "codex" : "claude");

  const prompt = buildValidationPrompt(args, ctx.parentRunner);

  // Delegate through the existing transport. Self-delegation and depth guards
  // already live in executeDelegate; reusing them keeps validate_run's blast
  // radius identical to delegate_run's.
  const delegateResult = await executeDelegate(
    {
      profileName: peer,
      prompt,
      sessionId: undefined,
      wait: true,
      timeoutSec: args.timeoutSec,
    },
    ctx,
  );

  // If executeDelegate already produced a non-ok payload (self-delegation,
  // depth, timeout, peer error), surface it verbatim — the calling agent
  // can react. Don't try to parse a verdict out of an error path.
  if (!delegateResult.ok) {
    return delegateResult;
  }

  const result = delegateResult.payload.result;
  const raw = typeof result === "string" ? result : "";
  const parsed = parseVerdict(raw);

  return {
    ok: true,
    payload: {
      ...delegateResult.payload,
      ...(parsed.verdict === "unknown"
        ? {
            verdict: parsed.verdict,
            summary: parsed.summary,
            issues: parsed.issues,
            parseError: parsed.parseError,
          }
        : {
            verdict: parsed.verdict,
            summary: parsed.summary,
            issues: parsed.issues,
          }),
    },
  };
}
