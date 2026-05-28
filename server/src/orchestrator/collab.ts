import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { RunEvent, RunnerKind, ToolLog } from "../../../shared/events.js";
import {
  executeCancelRun,
  startSubtaskRun,
  type DelegateRunRecord,
  type StartSubtaskRunArgs,
} from "../runners/delegate.js";

export type PlanStatus = "planned";
export type CollabRunStatus = "running" | "done" | "cancelled" | "error";
export type PhaseStatus = "pending" | "running" | "blocked" | "done" | "cancelled";
export type CollabMessageKind =
  | "note"
  | "request"
  | "response"
  | "decision"
  | "phase_summary";
export type PeerRole = "review" | "propose" | "verify" | "implement";

export type PlanRecord = {
  planId: string;
  owner: RunnerKind;
  participants: RunnerKind[];
  status: PlanStatus;
  createdAt: string;
  path: string;
  body: string;
  phases: string[];
};

export type CollabMessage = {
  id: string;
  from: RunnerKind;
  to?: RunnerKind;
  phaseId?: string;
  kind: CollabMessageKind;
  body: string;
  createdAt: number;
};

export type CollabDecision = {
  id: string;
  phaseId?: string;
  by: RunnerKind;
  summary: string;
  createdAt: number;
};

export type CollabPhase = {
  id: string;
  title: string;
  status: PhaseStatus;
  owner: RunnerKind;
  summary?: string;
  startedAt?: number;
  finishedAt?: number;
};

export type CollabRun = {
  id: string;
  sessionId: string;
  planId: string;
  planPath: string;
  planBody: string;
  leadRunner: RunnerKind;
  peerRunner: RunnerKind;
  status: CollabRunStatus;
  phases: CollabPhase[];
  messages: CollabMessage[];
  decisions: CollabDecision[];
  toolLogId: string;
  maxPeerTurns: number;
  peerTurns: number;
  activePeerRunIds: Set<string>;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
};

export type CollabSnapshot = {
  collabId: string;
  planId: string;
  planPath: string;
  leadRunner: RunnerKind;
  peerRunner: RunnerKind;
  status: CollabRunStatus;
  phases: Array<{
    id: string;
    title: string;
    status: PhaseStatus;
    owner: RunnerKind;
    summary?: string;
    durationMs?: number;
  }>;
  messages: number;
  decisions: number;
  peerTurns: number;
  maxPeerTurns: number;
  summary?: string;
};

export type PeerRunStarter = (
  args: StartSubtaskRunArgs,
) => { ok: true; record: DelegateRunRecord } | { ok: false; error: string };

const collabsBySession = new Map<string, Map<string, CollabRun>>();
const emitters = new Map<string, (event: RunEvent) => void>();

function safeId(prefix: string): string {
  return `${prefix}_${nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "plan";
}

function docsPlansDir(cwd: string): string {
  return path.resolve(cwd, "docs", "plans");
}

function toRepoPath(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/");
}

function resolvePlanPath(cwd: string, rawPath: string): string | null {
  const docsDir = docsPlansDir(cwd);
  const abs = path.resolve(cwd, rawPath);
  if (abs !== docsDir && !abs.startsWith(docsDir + path.sep)) return null;
  return abs;
}

function otherRunner(runner: RunnerKind): RunnerKind | null {
  if (runner === "claude") return "codex";
  if (runner === "codex") return "claude";
  return null;
}

function yamlList(items: string[]): string {
  return items.map((item) => `  - ${item}`).join("\n");
}

function markdownList(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

export type WritePlanArgs = {
  cwd: string;
  owner: RunnerKind;
  title: string;
  goal: string;
  phases: string[];
  scope?: string;
  risks?: string[];
  verification?: string[];
};

export type WritePlanResult =
  | { ok: true; planId: string; path: string }
  | { ok: false; error: string };

export async function writePlan(args: WritePlanArgs): Promise<WritePlanResult> {
  if (args.owner !== "claude" && args.owner !== "codex") {
    return { ok: false, error: "plan owner must be claude or codex" };
  }
  const title = args.title.trim();
  const goal = args.goal.trim();
  const phases = args.phases.map((p) => p.trim()).filter(Boolean);
  if (!title) return { ok: false, error: "title is required" };
  if (!goal) return { ok: false, error: "goal is required" };
  if (phases.length === 0) return { ok: false, error: "at least one phase is required" };

  const planId = safeId("plan");
  const createdAt = new Date().toISOString();
  const date = createdAt.slice(0, 10);
  const filename = `${date}-${slugify(title)}-${planId.slice("plan_".length)}.md`;
  const dir = docsPlansDir(args.cwd);
  const abs = path.join(dir, filename);

  const participants: RunnerKind[] = args.owner === "codex"
    ? ["codex", "claude"]
    : ["claude", "codex"];
  const risks = (args.risks ?? []).map((r) => r.trim()).filter(Boolean);
  const verification = (args.verification ?? []).map((v) => v.trim()).filter(Boolean);
  const body = [
    "---",
    `planId: ${planId}`,
    `owner: ${args.owner}`,
    "participants:",
    yamlList(participants),
    "status: planned",
    `createdAt: ${createdAt}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Goal",
    "",
    goal,
    "",
    "## Scope",
    "",
    args.scope?.trim() || "Implement the plan within the current repository.",
    "",
    "## Phases",
    "",
    markdownList(phases),
    "",
    "## Risks",
    "",
    risks.length ? markdownList(risks) : "1. No major risks identified.",
    "",
    "## Verification",
    "",
    verification.length ? markdownList(verification) : "1. Run focused tests and typecheck.",
    "",
  ].join("\n");

  await mkdir(dir, { recursive: true });
  await writeFile(abs, body, "utf8");
  return { ok: true, planId, path: toRepoPath(args.cwd, abs) };
}

export type ReadPlanArgs = {
  cwd: string;
  planId?: string;
  path?: string;
};

export type ReadPlanResult =
  | { ok: true; plan: PlanRecord }
  | { ok: false; error: string };

export async function readPlan(args: ReadPlanArgs): Promise<ReadPlanResult> {
  const abs = args.path
    ? resolvePlanPath(args.cwd, args.path)
    : args.planId
      ? await findPlanById(args.cwd, args.planId)
      : null;
  if (!abs) return { ok: false, error: "plan not found" };

  let body: string;
  try {
    body = await readFile(abs, "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const parsed = parsePlan(body);
  if (!parsed.planId) return { ok: false, error: "plan file is missing planId" };
  if (args.planId && parsed.planId !== args.planId) {
    return { ok: false, error: `planId mismatch: expected ${args.planId}` };
  }
  return {
    ok: true,
    plan: {
      planId: parsed.planId,
      owner: parsed.owner,
      participants: parsed.participants,
      status: "planned",
      createdAt: parsed.createdAt,
      path: toRepoPath(args.cwd, abs),
      body,
      phases: parsed.phases,
    },
  };
}

async function findPlanById(cwd: string, planId: string): Promise<string | null> {
  const dir = docsPlansDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const abs = path.join(dir, entry);
    const body = await readFile(abs, "utf8").catch(() => "");
    if (body.includes(`planId: ${planId}`)) return abs;
  }
  return null;
}

function parsePlan(body: string): {
  planId: string;
  owner: RunnerKind;
  participants: RunnerKind[];
  createdAt: string;
  phases: string[];
} {
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = new Map<string, string>();
  const participants: RunnerKind[] = [];
  if (frontmatter) {
    const lines = frontmatter[1]!.split("\n");
    let inParticipants = false;
    for (const line of lines) {
      if (line.startsWith("participants:")) {
        inParticipants = true;
        continue;
      }
      if (inParticipants && line.startsWith("  - ")) {
        const runner = line.slice(4).trim();
        if (runner === "claude" || runner === "codex") participants.push(runner);
        continue;
      }
      inParticipants = false;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
  }
  const owner = meta.get("owner") === "claude" ? "claude" : "codex";
  return {
    planId: meta.get("planId") ?? "",
    owner,
    participants: participants.length ? participants : [owner, otherRunner(owner)!],
    createdAt: meta.get("createdAt") ?? "",
    phases: parsePhases(body),
  };
}

function parsePhases(body: string): string[] {
  const m = body.match(/(?:^|\n)## Phases\s*\n([\s\S]*?)(?:\n## |\s*$)/);
  if (!m) return [];
  return m[1]!
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^(?:[-*]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

export function registerCollabEmitter(sessionId: string, fn: (event: RunEvent) => void): void {
  emitters.set(sessionId, fn);
}

export function unregisterCollabEmitter(sessionId: string): void {
  emitters.delete(sessionId);
}

function registerCollab(run: CollabRun): void {
  let bySession = collabsBySession.get(run.sessionId);
  if (!bySession) {
    bySession = new Map();
    collabsBySession.set(run.sessionId, bySession);
  }
  bySession.set(run.id, run);
}

function lookupCollab(collabId: string): CollabRun | undefined {
  for (const bySession of collabsBySession.values()) {
    const run = bySession.get(collabId);
    if (run) return run;
  }
  return undefined;
}

function snapshot(run: CollabRun): CollabSnapshot {
  return {
    collabId: run.id,
    planId: run.planId,
    planPath: run.planPath,
    leadRunner: run.leadRunner,
    peerRunner: run.peerRunner,
    status: run.status,
    phases: run.phases.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      owner: p.owner,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.startedAt != null
        ? { durationMs: (p.finishedAt ?? Date.now()) - p.startedAt }
        : {}),
    })),
    messages: run.messages.length,
    decisions: run.decisions.length,
    peerTurns: run.peerTurns,
    maxPeerTurns: run.maxPeerTurns,
    ...(run.summary ? { summary: run.summary } : {}),
  };
}

function emitCollabSnapshot(run: CollabRun): void {
  const fn = emitters.get(run.sessionId);
  if (!fn) return;
  const log: ToolLog = {
    id: run.toolLogId,
    name: "collab",
    input: { planId: run.planId, path: run.planPath },
    output: snapshot(run),
    isError: run.status === "error",
  };
  fn({ type: "tool_log", log });
}

export type StartCollabArgs = {
  sessionId: string;
  cwd: string;
  leadRunner: RunnerKind;
  planId?: string;
  path?: string;
  maxPeerTurns?: number;
};

export type StartCollabResult =
  | { ok: true; collabId: string; snapshot: CollabSnapshot }
  | { ok: false; error: string };

export async function startCollab(args: StartCollabArgs): Promise<StartCollabResult> {
  const peer = otherRunner(args.leadRunner);
  if (!peer) return { ok: false, error: "collaboration lead must be claude or codex" };
  const loaded = await readPlan({ cwd: args.cwd, planId: args.planId, path: args.path });
  if (!loaded.ok) return loaded;

  const phases = loaded.plan.phases.length ? loaded.plan.phases : ["Execute plan"];
  const run: CollabRun = {
    id: safeId("collab"),
    sessionId: args.sessionId,
    planId: loaded.plan.planId,
    planPath: loaded.plan.path,
    planBody: loaded.plan.body,
    leadRunner: args.leadRunner,
    peerRunner: peer,
    status: "running",
    phases: phases.map((title) => ({
      id: safeId("phase"),
      title,
      status: "pending",
      owner: args.leadRunner,
    })),
    messages: [],
    decisions: [],
    toolLogId: `collab:${safeId("log")}`,
    maxPeerTurns: args.maxPeerTurns ?? 8,
    peerTurns: 0,
    activePeerRunIds: new Set(),
    startedAt: Date.now(),
  };
  registerCollab(run);
  emitCollabSnapshot(run);
  return { ok: true, collabId: run.id, snapshot: snapshot(run) };
}

export type ObserveCollabResult =
  | { ok: true; snapshot: CollabSnapshot }
  | { ok: false; error: string };

export function observeCollab(collabId: string): ObserveCollabResult {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  return { ok: true, snapshot: snapshot(run) };
}

function findPhase(run: CollabRun, phaseId?: string): CollabPhase | undefined {
  if (phaseId) return run.phases.find((p) => p.id === phaseId);
  return run.phases.find((p) => p.status === "pending") ?? run.phases[0];
}

export function startPhase(
  collabId: string,
  phaseId?: string,
): { ok: true; phaseId: string; snapshot: CollabSnapshot } | { ok: false; error: string } {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  if (run.status !== "running") return { ok: false, error: `collaboration is ${run.status}` };
  const phase = findPhase(run, phaseId);
  if (!phase) return { ok: false, error: "phase not found" };
  phase.status = "running";
  phase.startedAt = phase.startedAt ?? Date.now();
  emitCollabSnapshot(run);
  return { ok: true, phaseId: phase.id, snapshot: snapshot(run) };
}

export type SendCollabMessageArgs = {
  from: RunnerKind;
  to?: RunnerKind;
  phaseId?: string;
  kind: CollabMessageKind;
  body: string;
};

export function sendCollabMessage(
  collabId: string,
  args: SendCollabMessageArgs,
): { ok: true; message: CollabMessage; snapshot: CollabSnapshot } | { ok: false; error: string } {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  const body = args.body.trim();
  if (!body) return { ok: false, error: "message body is required" };
  const message = appendMessage(run, args.kind, args.from, body, args.phaseId, args.to);
  if (args.kind === "decision") appendDecision(run, args.from, body, args.phaseId);
  emitCollabSnapshot(run);
  return { ok: true, message, snapshot: snapshot(run) };
}

function appendMessage(
  run: CollabRun,
  kind: CollabMessageKind,
  from: RunnerKind,
  body: string,
  phaseId?: string,
  to?: RunnerKind,
): CollabMessage {
  const message: CollabMessage = {
    id: safeId("msg"),
    from,
    kind,
    body,
    createdAt: Date.now(),
    ...(to ? { to } : {}),
    ...(phaseId ? { phaseId } : {}),
  };
  run.messages.push(message);
  return message;
}

function appendDecision(
  run: CollabRun,
  by: RunnerKind,
  summary: string,
  phaseId?: string,
): CollabDecision {
  const decision: CollabDecision = {
    id: safeId("decision"),
    by,
    summary,
    createdAt: Date.now(),
    ...(phaseId ? { phaseId } : {}),
  };
  run.decisions.push(decision);
  return decision;
}

export function donePhase(
  collabId: string,
  phaseId: string,
  summary?: string,
): { ok: true; phaseId: string; snapshot: CollabSnapshot } | { ok: false; error: string } {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  const phase = run.phases.find((p) => p.id === phaseId);
  if (!phase) return { ok: false, error: `unknown phaseId: ${phaseId}` };
  phase.status = "done";
  phase.summary = summary;
  phase.finishedAt = Date.now();
  if (summary?.trim()) {
    appendMessage(run, "phase_summary", phase.owner, summary.trim(), phase.id);
  }
  emitCollabSnapshot(run);
  return { ok: true, phaseId: phase.id, snapshot: snapshot(run) };
}

export function handoffPhase(
  collabId: string,
  phaseId: string,
  args: { owner: RunnerKind; makeLead?: boolean; note?: string },
): { ok: true; phaseId: string; snapshot: CollabSnapshot } | { ok: false; error: string } {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  if (args.owner !== "claude" && args.owner !== "codex") {
    return { ok: false, error: "phase owner must be claude or codex" };
  }
  const phase = run.phases.find((p) => p.id === phaseId);
  if (!phase) return { ok: false, error: `unknown phaseId: ${phaseId}` };
  const previousLead = run.leadRunner;
  phase.owner = args.owner;
  if (args.makeLead) {
    run.leadRunner = args.owner;
    run.peerRunner = otherRunner(args.owner)!;
  }
  const note = args.note?.trim() || `Phase handed off to ${args.owner}.`;
  appendMessage(run, "decision", previousLead, note, phase.id, args.owner);
  appendDecision(run, previousLead, note, phase.id);
  emitCollabSnapshot(run);
  return { ok: true, phaseId: phase.id, snapshot: snapshot(run) };
}

export type AskPeerArgs = {
  phaseId?: string;
  request: string;
  role: PeerRole;
  timeoutSec: number;
  parentCwd: string;
  depth: number;
  maxTurns?: number;
};

export type AskPeerResult =
  | { ok: true; message: CollabMessage; snapshot: CollabSnapshot }
  | { ok: false; error: string };

export async function askPeer(
  collabId: string,
  args: AskPeerArgs,
  starter: PeerRunStarter = startSubtaskRun,
): Promise<AskPeerResult> {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  if (run.status !== "running") return { ok: false, error: `collaboration is ${run.status}` };
  if (run.peerTurns >= run.maxPeerTurns) {
    return { ok: false, error: `peer turn limit reached (${run.maxPeerTurns})` };
  }
  const request = args.request.trim();
  if (!request) return { ok: false, error: "request is required" };
  const phase = findPhase(run, args.phaseId);
  appendMessage(run, "request", run.leadRunner, request, phase?.id, run.peerRunner);

  const started = starter({
    runner: run.peerRunner,
    prompt: buildPeerPrompt(run, phase, args.role, request),
    parentRunner: run.leadRunner,
    parentSessionId: run.sessionId,
    parentCwd: args.parentCwd,
    depth: args.depth,
    claudePermissionMode:
      run.peerRunner === "claude" && args.role !== "implement" ? "dontAsk" : undefined,
    claudeAllowedTools:
      run.peerRunner === "claude" && args.role !== "implement"
        ? ["Read", "Grep", "Glob"]
        : undefined,
    claudeMaxTurns: run.peerRunner === "claude" ? args.maxTurns : undefined,
  });
  if (!started.ok) return { ok: false, error: started.error };

  run.peerTurns += 1;
  run.activePeerRunIds.add(started.record.runId);
  emitCollabSnapshot(run);

  const TIMEOUT = Symbol("collab-peer-timeout");
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    const handle = setTimeout(() => resolve(TIMEOUT), args.timeoutSec * 1000);
    handle.unref();
  });
  const outcome = await Promise.race([
    started.record.work.then(() => "done" as const),
    deadline,
  ]);
  run.activePeerRunIds.delete(started.record.runId);

  if (outcome === TIMEOUT) {
    started.record.abort.abort();
    const error = `peer turn timed out after ${args.timeoutSec}s`;
    const message = appendMessage(run, "response", run.peerRunner, error, phase?.id, run.leadRunner);
    emitCollabSnapshot(run);
    return { ok: false, error: message.body };
  }
  const body = started.record.result || started.record.error || "";
  const message = appendMessage(
    run,
    "response",
    run.peerRunner,
    body || `peer ended with status ${started.record.status}`,
    phase?.id,
    run.leadRunner,
  );
  emitCollabSnapshot(run);
  return { ok: true, message, snapshot: snapshot(run) };
}

function buildPeerPrompt(
  run: CollabRun,
  phase: CollabPhase | undefined,
  role: PeerRole,
  request: string,
): string {
  const recent = run.messages.slice(-8).map((m) => {
    const phaseLabel = m.phaseId ? ` phase=${m.phaseId}` : "";
    const toLabel = m.to ? ` -> ${m.to}` : "";
    return `[${m.kind}] ${m.from}${toLabel}${phaseLabel}: ${m.body}`;
  });
  return [
    `You are ${run.peerRunner}, collaborating with ${run.leadRunner} on a shared plan.`,
    `Role for this turn: ${role}.`,
    "",
    `Plan file: ${run.planPath}`,
    "",
    run.planBody,
    "",
    "Current phase:",
    phase
      ? `${phase.id}: ${phase.title} (${phase.status}, owner=${phase.owner})`
      : "(no active phase)",
    "",
    "Recent collaboration messages:",
    recent.length ? recent.join("\n") : "(none)",
    "",
    "Lead request:",
    request,
    "",
    "Respond with concrete, bounded output for this request. Do not start an unbounded loop.",
  ].join("\n");
}

export function finishCollab(
  collabId: string,
  summary?: string,
): { ok: true; collabId: string; status: "done"; snapshot: CollabSnapshot } | { ok: false; error: string } {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  run.status = "done";
  run.summary = summary;
  run.finishedAt = Date.now();
  emitCollabSnapshot(run);
  return { ok: true, collabId: run.id, status: "done", snapshot: snapshot(run) };
}

export function cancelCollab(
  collabId: string,
): { ok: true; collabId: string; cancelled: number; snapshot: CollabSnapshot } | { ok: false; error: string } {
  const run = lookupCollab(collabId);
  if (!run) return { ok: false, error: `unknown collabId: ${collabId}` };
  const cancelled = cancelActivePeerRuns(run);
  for (const phase of run.phases) {
    if (phase.status === "pending" || phase.status === "running") phase.status = "cancelled";
  }
  run.status = "cancelled";
  run.finishedAt = Date.now();
  emitCollabSnapshot(run);
  return { ok: true, collabId: run.id, cancelled, snapshot: snapshot(run) };
}

function cancelActivePeerRuns(run: CollabRun): number {
  let cancelled = 0;
  for (const runId of run.activePeerRunIds) {
    executeCancelRun(runId);
    cancelled += 1;
  }
  run.activePeerRunIds.clear();
  return cancelled;
}

export function cancelCollabsForSession(sessionId: string): number {
  const bySession = collabsBySession.get(sessionId);
  if (!bySession) return 0;
  let cancelled = 0;
  for (const run of bySession.values()) {
    if (run.status === "done" || run.status === "cancelled") continue;
    cancelled += cancelActivePeerRuns(run);
    run.status = "cancelled";
    run.finishedAt = Date.now();
  }
  return cancelled;
}

export function clearCollabsForSession(sessionId: string): CollabRun[] {
  const runs = Array.from(collabsBySession.get(sessionId)?.values() ?? []);
  collabsBySession.delete(sessionId);
  return runs;
}
