// /consensus — single-cycle adversarial actor/critic pass.
//
// Exactly two LLM calls, in order:
//   1. PRODUCER writes the actual answer to the user's task (concrete code
//      / config / prose — not a plan). Read-only tools to ground in repo.
//   2. CRITIC reviews that single draft and emits a verdict JSON block
//      `{verdict: "agree" | "revise", summary: "…"}`.
//
// That's it. No loop, no revise round. The user sees the draft + critic's
// take and picks who implements. This bounds total cost to 2 LLM calls per
// /consensus invocation — a loop with convergence detection was easy to
// burn tokens on when the agents kept disagreeing.
//
// Tools: both roles are locked to read-only (`Read`, `Grep`, `Glob`) via
// `permissionMode: "dontAsk"` + `allowedTools`. Producer doesn't edit the
// repo — the answer goes to the user's chosen implementer turn, which
// applies it through the normal path.

import { z } from "zod";
import type {
  ConsensusIteration,
  ConsensusReady,
  ConsensusVerdict,
  RunEvent,
  RunnerKind,
} from "../../../shared/events.js";
import {
  startSubtaskRun,
  type DelegateRunRecord,
} from "../runners/delegate.js";

// Server-side cache of the most recent consensus_ready per session. Keeps
// enough state to handle an `implement` follow-up and to replay the modal
// on a reconnecting client. Cleared on /clear, delete_session, or after
// the user picks implement / cancel.
const readyBySession = new Map<string, ConsensusReady>();

export function getConsensusReady(sessionId: string): ConsensusReady | null {
  return readyBySession.get(sessionId) ?? null;
}

export function setConsensusReady(ready: ConsensusReady): void {
  readyBySession.set(ready.sessionId, ready);
}

export function clearConsensusReady(sessionId: string): boolean {
  return readyBySession.delete(sessionId);
}

export type ConsensusPair = {
  producer: RunnerKind;
  critic: RunnerKind;
};

export type ConsensusContext = {
  parentSessionId: string;
  parentCwd: string;
  pair: ConsensusPair;
  depth: number;
  // Optional per-call tool-call budget for each peer (Claude maxTurns /
  // Vercel maxSteps). Undefined = no cap; the agent runs until it stops
  // generating tool calls or hits timeoutSec. Set this when you want a hard
  // limit (e.g. user passed `max=N` on the slash command). The SDK counts
  // every assistant turn — including tool-call turns — so a small value
  // here can starve the draft itself.
  maxTurnsPerPeer?: number;
  // Per-call wall-clock timeout.
  timeoutSec: number;
  // Parent-turn abort signal. Checked between the producer and critic
  // calls so an interrupt during the producer's call kills the cycle
  // before the critic spins up.
  signal: AbortSignal;
  onPeerEvent: (record: DelegateRunRecord, event: RunEvent) => void;
  // Fires after each call settles (producer then critic). index.ts uses
  // this to emit a `consensus_step` anchor tool_log that backward-folds
  // the streaming peer events into a labelled closed group.
  onIterationStep?: (info: {
    role: "producer" | "critic";
    runner: RunnerKind;
    replyChars: number;
    verdict?: ConsensusVerdict;
    summary?: string;
    error?: string;
  }) => void;
};

// Read-only tools the consensus peers may use. Excluding Edit/Write/Bash/
// ExitPlanMode keeps a peer Claude from breaking out of the loop and
// editing files mid-conversation.
const CONSENSUS_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

const TASK_MAX = 4_000;
const DRAFT_MAX = 16_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated to ${max} chars]…`;
}

// ───────────────────────── prompt builders ─────────────────────────

function buildProducerPrompt(task: string): string {
  return [
    "You are the PRODUCER in a single-pass actor/critic exchange. A CRITIC (a peer model) will review your draft ONCE and emit a verdict — there is no revise round. Get it right the first time.",
    "",
    "Your job: produce the ACTUAL ANSWER to the user's task. Not a plan. Not \"I would do X\" — produce X. Write the code, the config, the design, the prose — whatever the task demands. Concrete content the user could ship.",
    "",
    "GROUND IN REALITY FIRST. Before writing, use Read / Grep / Glob to look at the repo:",
    "  - which files already exist and how they're structured",
    "  - what conventions, naming, imports, types the codebase uses",
    "  - what the relevant existing code does today",
    "Drafts written without checking the repo are easy to shred. Don't guess at file paths or APIs — verify them. You have read-only tools; use them.",
    "",
    "Output your FULL DRAFT in your reply. There's only one chance — make it complete and precise.",
    "",
    "TASK:",
    truncate(task, TASK_MAX),
    "",
    "Explore the repo as needed, then write your complete draft.",
  ].join("\n");
}

function buildCriticPrompt(task: string, producerDraft: string): string {
  return [
    "You are the CRITIC in a single-pass actor/critic exchange. A PRODUCER (a peer model) has written one draft answer to the user's task. Your job: review it ONCE and emit a verdict. There is no revise round — your verdict is final input to the user, not the producer.",
    "",
    "GROUND IN REALITY. Before declaring anything right or wrong, VERIFY against the actual repo. Use Read / Grep / Glob to:",
    "  - check that files the producer references actually exist at the paths claimed",
    "  - check that functions/APIs/types the producer uses actually exist with the signatures claimed",
    "  - check that the producer's approach matches the codebase's existing conventions",
    "  - find existing patterns the producer should have followed but didn't",
    "A critique without repo evidence is weak. A critique that cites file:line is strong.",
    "",
    "Look for: incorrect code or config, missing edge cases, broken assumptions, weak design choices, security issues, scope drift from the task, divergence from existing repo conventions. Don't critique style/formatting unless it affects correctness. Don't stall on nitpicks.",
    "",
    "Emit AGREE only if the draft is genuinely sound — if you're verifying repo claims and they hold up. Otherwise REVISE with specific issues (cite parts of the draft AND file/line in the repo).",
    "",
    "End your response with EXACTLY this JSON block (and nothing after it):",
    "```json",
    '{"verdict":"agree"|"revise","summary":"one-line status"}',
    "```",
    "",
    "TASK:",
    truncate(task, TASK_MAX),
    "",
    "The PRODUCER's draft:",
    "",
    truncate(producerDraft, DRAFT_MAX),
    "",
    "Check it against the actual repo with Read/Grep/Glob, then review.",
  ].join("\n");
}

// ───────────────────────── verdict parser ─────────────────────────

const VerdictSchema = z.object({
  verdict: z.enum(["agree", "revise"]),
  summary: z.string().default(""),
});

const JSON_FENCE = /```json\s*([\s\S]*?)\s*```\s*$/i;

function parseVerdict(raw: string): {
  verdict: ConsensusVerdict;
  summary: string;
  parseError?: string;
} {
  const m = raw.match(JSON_FENCE);
  if (!m) {
    return {
      verdict: "unknown",
      summary: "no JSON verdict block found",
      parseError: "no ```json fence at end of response",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (err) {
    return {
      verdict: "unknown",
      summary: "verdict JSON did not parse",
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return {
      verdict: "unknown",
      summary: "verdict JSON did not match schema",
      parseError: result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    };
  }
  return { verdict: result.data.verdict, summary: result.data.summary };
}

// Strip the trailing JSON fence so the UI shows the critic's prose without
// the machine-readable block at the bottom.
function stripVerdictFence(raw: string): string {
  const m = raw.match(JSON_FENCE);
  if (!m) return raw.trim();
  return raw.slice(0, m.index).trim();
}

// ───────────────────────── one-call wrapper ─────────────────────────

type CallOutcome = {
  text: string;
  sessionId?: string;
  error?: string;
};

async function runOneCall(args: {
  runner: RunnerKind;
  prompt: string;
  sessionId?: string;
  ctx: ConsensusContext;
  label: string;
}): Promise<CallOutcome> {
  const started = startSubtaskRun({
    runner: args.runner,
    prompt: args.prompt,
    sessionId: args.sessionId,
    parentRunner: args.ctx.pair.producer,
    parentSessionId: args.ctx.parentSessionId,
    parentCwd: args.ctx.parentCwd,
    depth: args.ctx.depth + 1,
    claudePermissionMode: args.runner === "claude" ? "dontAsk" : undefined,
    claudeAllowedTools:
      args.runner === "claude" ? CONSENSUS_ALLOWED_TOOLS : undefined,
    claudeMaxTurns:
      args.runner === "claude" ? args.ctx.maxTurnsPerPeer : undefined,
    vercelMaxSteps:
      args.runner === "vercel" ? args.ctx.maxTurnsPerPeer : undefined,
    onPeerEvent: args.ctx.onPeerEvent,
  });
  if (!started.ok) {
    return { text: "", error: started.error };
  }

  const timeoutMs = args.ctx.timeoutSec * 1000;
  const TIMEOUT = Symbol("consensus-timeout");
  const deadline = new Promise<typeof TIMEOUT>((resolve) =>
    setTimeout(() => resolve(TIMEOUT), timeoutMs).unref(),
  );
  const outcome = await Promise.race([
    started.record.work.then(() => "done" as const),
    deadline,
  ]);
  if (outcome === TIMEOUT) {
    started.record.abort.abort();
    return {
      text: started.record.result ?? "",
      sessionId: started.record.sessionId,
      error: `${args.label} timed out after ${args.ctx.timeoutSec}s`,
    };
  }
  if (started.record.status === "ok") {
    return {
      text: started.record.result,
      sessionId: started.record.sessionId,
    };
  }
  return {
    text: started.record.result ?? "",
    sessionId: started.record.sessionId,
    error:
      started.record.error ??
      `${args.label} ended with status: ${started.record.status}`,
  };
}

// ───────────────────────── the loop ─────────────────────────

export type ConsensusResult = {
  iterations: ConsensusIteration[];
  finalDraft: string;
  converged: boolean;
  errors: string[];
};

export async function runConsensus(
  task: string,
  ctx: ConsensusContext,
): Promise<ConsensusResult> {
  const { producer, critic } = ctx.pair;
  const iterations: ConsensusIteration[] = [];
  const errors: string[] = [];

  if (ctx.signal.aborted) {
    return { iterations, finalDraft: "", converged: false, errors };
  }

  // ── PRODUCER ────────────────────────────────────────────────
  const pOut = await runOneCall({
    runner: producer,
    prompt: buildProducerPrompt(task),
    ctx,
    label: `producer (${producer})`,
  });
  if (pOut.error) errors.push(pOut.error);
  const draft = pOut.text || "";
  ctx.onIterationStep?.({
    role: "producer",
    runner: producer,
    replyChars: pOut.text.length,
    error: pOut.error,
  });

  // No draft → can't review. Record the failure and surface to the user.
  if (!draft && pOut.error) {
    iterations.push({
      index: 0,
      producerText: "",
      criticText: "",
      verdict: "unknown",
      summary: "producer call failed before producing text",
      parseError: pOut.error,
    });
    return { iterations, finalDraft: "", converged: false, errors };
  }

  if (ctx.signal.aborted) {
    return { iterations, finalDraft: draft, converged: false, errors };
  }

  // ── CRITIC ──────────────────────────────────────────────────
  const cOut = await runOneCall({
    runner: critic,
    prompt: buildCriticPrompt(task, draft),
    ctx,
    label: `critic (${critic})`,
  });
  if (cOut.error) errors.push(cOut.error);

  const parsed = parseVerdict(cOut.text);
  iterations.push({
    index: 0,
    producerText: draft,
    criticText: stripVerdictFence(cOut.text),
    verdict: parsed.verdict,
    summary: parsed.summary,
    ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
  });
  ctx.onIterationStep?.({
    role: "critic",
    runner: critic,
    replyChars: cOut.text.length,
    verdict: parsed.verdict,
    summary: parsed.summary,
    error: cOut.error,
  });

  return {
    iterations,
    finalDraft: draft,
    converged: parsed.verdict === "agree",
    errors,
  };
}
