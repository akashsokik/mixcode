// /consensus — adversarial actor/critic loop.
//
// Two roles, two runners:
//   PRODUCER writes the actual answer to the user's task — concrete code,
//   config, prose, whatever the task demands. Not a plan.
//
//   CRITIC reviews each draft and tries to find real problems. Each turn
//   the critic emits a JSON verdict block: `{verdict: "agree" | "revise"}`.
//
// The loop iterates:
//   i=0: producer writes first draft → critic reviews
//   i=1: producer revises (sees critic's review) → critic reviews again
//   …
// Terminates on critic AGREE or after maxRounds iterations. The final
// deliverable is the producer's latest draft; if `converged` is false the
// user is shown the unresolved critic concerns alongside it.
//
// Session continuity: each role has its own peer session id (Claude
// resumeId / Codex threadId) carried across iterations, so each agent is
// actually continuing its own conversation — building on prior context
// rather than getting served a fresh transcript every turn. This is how
// "talking to each other" emerges; without continuity it's just essays.
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
  // Optional per-iteration tool-call budget for each peer (Claude maxTurns
  // / Vercel maxSteps). Undefined = no cap; the agent runs until it stops
  // generating tool calls or hits timeoutSec. Set this when you want a hard
  // limit (e.g. user passed `max=N` on the slash command). The SDK counts
  // every assistant turn — including tool-call turns — so a small value
  // here can starve the draft itself.
  maxTurnsPerPeer?: number;
  // Max actor/critic iterations before forced exit. Default 6 — i.e. up to
  // 3 producer drafts and 3 critic reviews.
  maxRounds: number;
  // Per-call wall-clock timeout. Producer/critic calls can be slower than
  // round-1 essays because of session-carried context.
  timeoutSec: number;
  // Parent-turn abort signal. Checked between iterations so an interrupt
  // doesn't burn through every remaining round before noticing — the
  // peer-cancellation listener only kills the call that's *currently*
  // running; without checking signal.aborted between steps the loop
  // happily starts the next iteration and gets it cancelled too.
  signal: AbortSignal;
  onPeerEvent: (record: DelegateRunRecord, event: RunEvent) => void;
};

// Read-only tools the consensus peers may use. Excluding Edit/Write/Bash/
// ExitPlanMode keeps a peer Claude from breaking out of the loop and
// editing files mid-conversation.
const CONSENSUS_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

const TASK_MAX = 4_000;
const DRAFT_MAX = 16_000;
const CRITIQUE_MAX = 8_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated to ${max} chars]…`;
}

// ───────────────────────── prompt builders ─────────────────────────

function buildProducerInitial(task: string): string {
  return [
    "You are the PRODUCER in an adversarial pair-writing loop. A CRITIC (a peer model) reviews every draft you write and tries to find real problems with it.",
    "",
    "Your job: produce the ACTUAL ANSWER to the user's task. Not a plan. Not \"I would do X\" — produce X. Write the code, the config, the design, the prose — whatever the task demands. Concrete content the user could ship.",
    "",
    "GROUND IN REALITY FIRST. Before writing anything, use Read / Grep / Glob to actually look at the repo:",
    "  - which files already exist and how they're structured",
    "  - what conventions, naming, imports, types the codebase uses",
    "  - what the relevant existing code does today",
    "Drafts written without checking the repo are easy for the critic to shred. Don't guess at file paths or APIs — verify them. You have read-only tools; use them.",
    "",
    "Each turn you'll output your FULL CURRENT DRAFT. The critic only reads your latest message, not the diff. Each revision must contain the whole thing.",
    "",
    "The loop ends when the critic emits AGREE. Make their job easy by being precise.",
    "",
    "TASK:",
    truncate(task, TASK_MAX),
    "",
    "Explore the repo with Read/Grep/Glob as needed, then write your first complete draft.",
  ].join("\n");
}

function buildProducerRevise(criticText: string): string {
  return [
    "The CRITIC reviewed your draft. Their response:",
    "",
    truncate(criticText, CRITIQUE_MAX),
    "",
    "If the critic flagged something about the repo (a file, a function, a convention), VERIFY IT WITH Read/Grep/Glob before agreeing or pushing back. Don't accept a claim about reality without checking, and don't defend yours without checking either.",
    "",
    "Revise. Where you agree with the critic, fix it. Where you disagree, briefly explain why — citing the file/line you read if applicable.",
    "",
    "Output your FULL CURRENT DRAFT (not a diff). The critic only reads your latest message.",
  ].join("\n");
}

function buildCriticInitial(task: string, producerDraft: string): string {
  return [
    "You are the CRITIC in an adversarial pair-writing loop. A PRODUCER (a peer model) is writing the actual answer to the user's task. Your job: find real problems with each draft.",
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
    "When the producer has addressed your prior concerns AND your repo checks confirm the draft is sound, emit AGREE. Be specific about what's wrong and where — cite parts of the draft AND the file/line in the repo.",
    "",
    "End EVERY response with EXACTLY this JSON block (and nothing after it):",
    "```json",
    '{"verdict":"agree"|"revise","summary":"one-line status"}',
    "```",
    "",
    "TASK:",
    truncate(task, TASK_MAX),
    "",
    "The PRODUCER's first draft:",
    "",
    truncate(producerDraft, DRAFT_MAX),
    "",
    "Check it against the actual repo with Read/Grep/Glob, then review.",
  ].join("\n");
}

function buildCriticFollowup(producerDraft: string): string {
  return [
    "The PRODUCER revised. Their new draft:",
    "",
    truncate(producerDraft, DRAFT_MAX),
    "",
    "Re-check against the repo. Use Read/Grep/Glob to verify the producer's changes are actually correct — don't just trust their prose. If they cite a file/line, open it.",
    "",
    "If they addressed your prior concerns and your repo checks confirm the draft is sound, emit AGREE. Otherwise list what's still wrong (with file:line where you can).",
    "",
    "End EVERY response with EXACTLY this JSON block (and nothing after it):",
    "```json",
    '{"verdict":"agree"|"revise","summary":"one-line status"}',
    "```",
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

  let producerSessionId: string | undefined;
  let criticSessionId: string | undefined;
  let lastDraft = "";
  let lastCriticText = "";
  let converged = false;

  for (let i = 0; i < ctx.maxRounds; i++) {
    if (ctx.signal.aborted) break;

    // ── Producer step ─────────────────────────────────────────
    const producerPrompt =
      i === 0 ? buildProducerInitial(task) : buildProducerRevise(lastCriticText);
    const pOut = await runOneCall({
      runner: producer,
      prompt: producerPrompt,
      sessionId: producerSessionId,
      ctx,
      label: `iter ${i} producer (${producer})`,
    });
    if (pOut.sessionId) producerSessionId = pOut.sessionId;
    if (pOut.error) errors.push(pOut.error);
    lastDraft = pOut.text || lastDraft;
    // If the producer call hard-errored without text, stop. The loop can't
    // make progress without a draft to review.
    if (!pOut.text && pOut.error) {
      iterations.push({
        index: i,
        producerText: lastDraft,
        criticText: "",
        verdict: "unknown",
        summary: "producer call failed before producing text",
        parseError: pOut.error,
      });
      break;
    }

    if (ctx.signal.aborted) break;

    // ── Critic step ───────────────────────────────────────────
    const criticPrompt =
      i === 0 ? buildCriticInitial(task, lastDraft) : buildCriticFollowup(lastDraft);
    const cOut = await runOneCall({
      runner: critic,
      prompt: criticPrompt,
      sessionId: criticSessionId,
      ctx,
      label: `iter ${i} critic (${critic})`,
    });
    if (cOut.sessionId) criticSessionId = cOut.sessionId;
    if (cOut.error) errors.push(cOut.error);
    lastCriticText = cOut.text;

    const parsed = parseVerdict(cOut.text);
    iterations.push({
      index: i,
      producerText: lastDraft,
      criticText: stripVerdictFence(cOut.text),
      verdict: parsed.verdict,
      summary: parsed.summary,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    });

    if (parsed.verdict === "agree") {
      converged = true;
      break;
    }
    if (ctx.signal.aborted) break;
  }

  return { iterations, finalDraft: lastDraft, converged, errors };
}
