import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type {
  AskUserAnnotation,
  PermissionDecision,
  PermissionRequest,
} from "../../shared/events.js";

const STORE_PATH = join(homedir(), ".adverserial-code", "permissions.json");

export type PermissionResolution = {
  decision: PermissionDecision;
  answers?: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
};

type Pending = {
  request: PermissionRequest;
  resolve: (resolution: PermissionResolution) => void;
  cleanup: () => void;
};

export class PermissionStore {
  private rules: string[] = [];
  private pending = new Map<string, Pending>();
  private onChange: ((rules: string[]) => void) | null = null;
  private onRequest: ((req: PermissionRequest) => void) | null = null;
  private onResolved: ((requestId: string) => void) | null = null;

  constructor() {
    this.load();
  }

  bind(handlers: {
    onChange: (rules: string[]) => void;
    onRequest: (req: PermissionRequest) => void;
    onResolved: (requestId: string) => void;
  }): void {
    this.onChange = handlers.onChange;
    this.onRequest = handlers.onRequest;
    this.onResolved = handlers.onResolved;
  }

  list(): string[] {
    return [...this.rules];
  }

  add(rule: string): string[] {
    const trimmed = rule.trim();
    if (!trimmed) return this.list();
    if (!this.rules.includes(trimmed)) {
      this.rules.push(trimmed);
      this.persist();
    }
    return this.list();
  }

  addMany(rules: string[]): string[] {
    let changed = false;
    for (const r of rules) {
      const t = r.trim();
      if (t && !this.rules.includes(t)) {
        this.rules.push(t);
        changed = true;
      }
    }
    if (changed) this.persist();
    return this.list();
  }

  remove(rule: string): string[] {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r !== rule.trim());
    if (this.rules.length !== before) this.persist();
    return this.list();
  }

  clear(): string[] {
    if (this.rules.length === 0) return this.list();
    this.rules = [];
    this.persist();
    return this.list();
  }

  // Open a permission prompt. Resolves with the user's decision or "deny"
  // when the abort signal fires (turn cancelled, session deleted).
  request(
    args: {
      sessionId: string;
      tool: string;
      input: unknown;
      title?: string;
      description?: string;
      suggestions: string[];
      signal: AbortSignal;
    },
  ): Promise<PermissionResolution> {
    const requestId = nanoid();
    const req: PermissionRequest = {
      requestId,
      sessionId: args.sessionId,
      tool: args.tool,
      input: args.input,
      title: args.title,
      description: args.description,
      suggestions: args.suggestions,
    };

    return new Promise<PermissionResolution>((resolve) => {
      const onAbort = (): void => {
        const p = this.pending.get(requestId);
        if (!p) return;
        this.pending.delete(requestId);
        this.onResolved?.(requestId);
        resolve({ decision: "deny" });
      };
      args.signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(requestId, {
        request: req,
        resolve,
        cleanup: () => args.signal.removeEventListener("abort", onAbort),
      });
      this.onRequest?.(req);
    });
  }

  // Called when a client responds to a permission_request. Returns false if
  // the requestId was unknown (already resolved or never existed).
  respond(requestId: string, resolution: PermissionResolution): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.cleanup();
    p.resolve(resolution);
    this.onResolved?.(requestId);
    return true;
  }

  // Snapshot of currently-pending requests, for late subscribers.
  pendingRequests(): PermissionRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  private load(): void {
    try {
      if (!existsSync(STORE_PATH)) return;
      const raw = readFileSync(STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { rules?: unknown }).rules)
      ) {
        const rules = (parsed as { rules: unknown[] }).rules.filter(
          (r): r is string => typeof r === "string" && r.trim().length > 0,
        );
        this.rules = Array.from(new Set(rules.map((r) => r.trim())));
      }
    } catch {
      this.rules = [];
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(STORE_PATH), { recursive: true });
      writeFileSync(
        STORE_PATH,
        JSON.stringify({ rules: this.rules }, null, 2),
        "utf8",
      );
    } catch {
      // Persistence is best-effort. Failing to write shouldn't kill the turn.
    }
    this.onChange?.(this.list());
  }
}
