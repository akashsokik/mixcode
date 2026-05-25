import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Append-only NDJSON audit log, one file per session at
// ~/.adverserial-code/transcripts/<sessionId>.ndjson.
//
// Two flavors of line:
//   - normalized: events that already flow through SessionManager (the same
//     RunEvent stream the UI renders). Use the structured `kind` field to
//     reconstruct conversation state.
//   - raw: the unfiltered SDK message stream (system init, raw assistant
//     blocks, tool_result ids, result summaries). Lossy events we drop on the
//     way to RunEvent are preserved here for audit / replay.
//
// File descriptors are held open for the lifetime of the process so the hot
// path is a single writeSync per line. close() releases the fd on session
// delete; closeAll() on process exit.

const ROOT =
  process.env.MIXCODE_TRANSCRIPT_DIR ??
  path.join(os.homedir(), ".adverserial-code", "transcripts");

export type TranscriptLine =
  | { kind: "session_created"; sessionId: string; title: string; runner: string; cwd: string }
  | { kind: "session_cleared"; sessionId: string }
  | { kind: "session_deleted"; sessionId: string }
  | { kind: "message_started"; sessionId: string; messageId: string; role: "user" | "assistant"; text: string }
  | { kind: "message_done"; sessionId: string; messageId: string }
  | { kind: "event"; sessionId: string; messageId: string; event: unknown }
  | { kind: "turn_usage"; sessionId: string; messageId: string; usage: unknown }
  | { kind: "raw_sdk"; sessionId: string; messageId: string; runner: "claude" | "codex" | "vercel"; raw: unknown }
  | {
      kind: "runtime";
      sessionId: string;
      field: "claudeSessionId" | "codexThreadId" | "vercelMessages";
      // string for resume ids; number for vercel message count (the full
      // ModelMessage[] is too noisy to dump on every turn).
      value: string | number | null;
    };

export class TranscriptLogger {
  private fds = new Map<string, number>();
  private root: string;

  constructor(root: string = ROOT) {
    this.root = root;
  }

  log(line: TranscriptLine): void {
    try {
      const fd = this.fd(line.sessionId);
      const payload = JSON.stringify({ at: new Date().toISOString(), ...line });
      writeSync(fd, payload + "\n");
    } catch (err) {
      // Audit log failure must not break the user's turn. Surface once and
      // continue — re-opening the fd on the next call will retry.
      console.error("[transcript] write failed:", err);
      this.close(line.sessionId);
    }
  }

  close(sessionId: string): void {
    const fd = this.fds.get(sessionId);
    if (fd == null) return;
    this.fds.delete(sessionId);
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }

  closeAll(): void {
    for (const fd of this.fds.values()) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
    this.fds.clear();
  }

  pathFor(sessionId: string): string {
    return path.join(this.root, `${sessionId}.ndjson`);
  }

  private fd(sessionId: string): number {
    const existing = this.fds.get(sessionId);
    if (existing != null) return existing;
    mkdirSync(this.root, { recursive: true });
    const fd = openSync(this.pathFor(sessionId), "a");
    this.fds.set(sessionId, fd);
    return fd;
  }
}
