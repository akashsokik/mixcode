import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { Transcript } from "./components/Transcript";
import { Prompt } from "./components/Prompt";
import { Spinner } from "./components/Spinner";
import { Notifications } from "./components/Notifications";
import { PermissionPanel } from "./components/PermissionPanel";
import { ConsensusModal } from "./components/ConsensusModal";
import { ModelPicker } from "./components/ModelPicker";
import { Palette, type PaletteItem } from "./components/Palette";
import type { ClaudePermissionMode, RunnerKind, SessionSkillEntry } from "../../shared/events.ts";
import { useSessions } from "./state/sessions";
import { parseSlash, SLASH_COMMANDS, toggleRunner } from "./util/slash";
import {
  contextLines,
  effortLines,
  helpLines,
  makeNotice,
  mcpActionLines,
  mcpListLines,
  mcpTestLines,
  lastTurnUsage,
  modelLines,
  permissionsLines,
  planLines,
  sessionsLines,
  skillInfoLines,
  skillsLines,
  type Notice,
} from "./util/notice";
import {
  makeNotification,
  type Notification,
  type NotificationKind,
} from "./util/notification";
import { treeLines } from "./util/tree";
import { normalizeRule } from "./util/permission-rule";
import {
  addSkill,
  importAllSkills,
  importSkill,
  listSkills,
  readSkillFrontmatter,
  removeSkill,
  type SkillEntry,
} from "./util/skills";
import { addMcp, listMcp, removeMcp, testMcp } from "./util/mcp";
import { theme } from "./theme";
import { basename } from "./util/path";
import { collectChatItemIds, latestDelegationId, resolveItemContent } from "./util/blocks";
import { writeClipboard } from "./util/clipboard";
import {
  formatTokens,
  prettyModelLabel,
  projectName,
} from "./util/status";
import type { MetaPair } from "./components/Prompt";

const EMPTY_SET: Set<string> = new Set();

// User messages and notices have no expanded view; second-click on them must
// not write phantom entries into expandedItems. Tool / assistant block /
// delegation group ids use the `${messageId}:${index}` or `${messageId}:d:${i}`
// shapes and are eligible (the renderer simply ignores `expanded` for atomic
// assistant blocks that have no expandedContent, so the Set stays bounded by
// the number of blocks in the active session).
function isExpandableItemId(id: string): boolean {
  return !id.startsWith("msg:") && !id.startsWith("notice:");
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export function App() {
  const { width, height } = useTerminalDimensions();
  const api = useSessions();
  const [notices, setNotices] = useState<Record<string, Notice[]>>({});
  // null when no picker is open. The picker captures keyboard input itself;
  // App only needs to track which runner it's for so it can keep the selected
  // model up to date if the user switches runners while it's open (closes).
  const [modelPicker, setModelPicker] = useState<{ runner: RunnerKind } | null>(null);
  const [paletteMode, setPaletteMode] = useState<
    "sessions" | "skills" | "mcp" | "global" | null
  >(null);
  // Toast-style transient notifications. Independent of `notices` (which are
  // per-session command output) — these are global, auto-dismissing, and
  // float over the layout for events like "copied to clipboard".
  const [notifications, setNotifications] = useState<Notification[]>([]);
  // Live mouse text selection from opentui's selection system. Captured here
  // so cmd+c can prefer the dragged text over the chat-item content.
  const dragSelectionRef = useRef<string>("");
  // Per-session chat-item selection + expansion. Selection navigates with
  // shift+up/shift+down; ctrl+e toggles expansion of whichever item is
  // selected (falling back to the latest delegation when nothing is selected).
  // The id space includes user messages, notices, assistant blocks, tool
  // cards, and delegation groups — see collectChatItemIds.
  const [selectedItemBySession, setSelectedItemBySession] = useState<
    Record<string, string | null>
  >({});
  const [expandedItems, setExpandedItems] = useState<
    Record<string, Set<string>>
  >({});
  const [skillEntries, setSkillEntries] = useState<SkillEntry[]>([]);
  const [mcpServerNames, setMcpServerNames] = useState<string[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);

  // Gate on `helloReceived`, not `status === "open"`. The WS opens a beat
  // before `hello` arrives, and during that window sessions.length is still
  // 0 even when the server has persisted sessions to bring back — without
  // this gate, every TUI start appended a stray empty session.
  useEffect(() => {
    if (api.helloReceived && api.sessions.length === 0) {
      api.createSession();
    }
  }, [api.helloReceived, api.sessions.length]);

  // Drop notices for sessions that no longer exist.
  useEffect(() => {
    setNotices((prev) => {
      const alive = new Set(api.sessions.map((s) => s.id));
      let changed = false;
      const next: Record<string, Notice[]> = {};
      for (const [id, list] of Object.entries(prev)) {
        if (alive.has(id)) next[id] = list;
        else changed = true;
      }
      return changed ? next : prev;
    });
    setExpandedItems((prev) => {
      const alive = new Set(api.sessions.map((s) => s.id));
      let changed = false;
      const next: Record<string, Set<string>> = {};
      for (const [id, set] of Object.entries(prev)) {
        if (alive.has(id)) next[id] = set;
        else changed = true;
      }
      return changed ? next : prev;
    });
    setSelectedItemBySession((prev) => {
      const alive = new Set(api.sessions.map((s) => s.id));
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [id, val] of Object.entries(prev)) {
        if (alive.has(id)) next[id] = val;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [api.sessions]);

  // Skills are read from disk — cheap enough to do synchronously when the
  // active runner changes. The list also feeds the prompt's slash
  // autocomplete, so we can't gate on paletteMode anymore (the autocomplete
  // needs the names before the user opens the palette).
  useEffect(() => {
    if (!api.active) return;
    setSkillEntries(listSkills(api.active.activeRunner));
  }, [api.active?.activeRunner]);

  // MCP list shells out to `<runner> mcp list` which can take seconds.
  // Defer past the render commit with setTimeout(0) so the palette opens
  // before the spawn blocks. The blocking spawn still happens — it just
  // doesn't block the open.
  useEffect(() => {
    if (!api.active) return;
    if (paletteMode !== "mcp") return; // intentionally not "global"
    let cancelled = false;
    setMcpLoading(true);
    const id = setTimeout(() => {
      if (cancelled) return;
      const runner = api.active!.activeRunner;
      const out = listMcp(runner);
      if (cancelled) return;
      setMcpServerNames(out.ok ? parseMcpNames(out.stdout) : []);
      setMcpLoading(false);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [paletteMode, api.active?.activeRunner]);

  const activeNotices = useMemo(
    () => (api.activeId ? notices[api.activeId] ?? [] : []),
    [notices, api.activeId],
  );

  const activeItemIds = useMemo(
    () => collectChatItemIds(api.active ?? null, activeNotices),
    [api.active, activeNotices],
  );

  const activeSelectedItemId = useMemo(() => {
    if (!api.activeId) return null;
    const id = selectedItemBySession[api.activeId] ?? null;
    // Drop a stale selection if the message that owned it has been
    // truncated (e.g. /clear) or the tool block index no longer exists.
    if (id && !activeItemIds.includes(id)) return null;
    return id;
  }, [selectedItemBySession, api.activeId, activeItemIds]);

  const activeExpandedItems = useMemo(
    () =>
      api.activeId ? expandedItems[api.activeId] ?? EMPTY_SET : EMPTY_SET,
    [expandedItems, api.activeId],
  );

  const moveItemSelection = useCallback(
    (direction: "prev" | "next") => {
      const sid = api.activeId;
      if (!sid) return;
      if (activeItemIds.length === 0) return;
      const current = selectedItemBySession[sid] ?? null;
      const currentIdx = current ? activeItemIds.indexOf(current) : -1;
      let nextIdx: number;
      if (currentIdx === -1) {
        // First press picks the most recent card (newest end of the list)
        // so the user lands on the card they're most likely to inspect.
        nextIdx = direction === "prev" ? activeItemIds.length - 1 : 0;
      } else if (direction === "prev") {
        nextIdx = currentIdx === 0 ? activeItemIds.length - 1 : currentIdx - 1;
      } else {
        nextIdx = currentIdx === activeItemIds.length - 1 ? 0 : currentIdx + 1;
      }
      setSelectedItemBySession((prev) => ({
        ...prev,
        [sid]: activeItemIds[nextIdx],
      }));
    },
    [api.activeId, activeItemIds, selectedItemBySession],
  );

  const toggleSelectedItemExpansion = useCallback(() => {
    const sid = api.activeId;
    if (!sid) return false;
    const id = selectedItemBySession[sid] ?? null;
    if (!id) return false;
    setExpandedItems((prev) => {
      const cur = prev[sid] ?? new Set<string>();
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [sid]: next };
    });
    return true;
  }, [api.activeId, selectedItemBySession]);

  // Mouse activation: first click selects the item; clicking the same already
  // selected item toggles its expansion (for expandable rows only — user
  // messages and notices have no expanded view, so second-click is a no-op).
  // This makes items behave like disclosure widgets without adding a separate
  // "expand" target.
  const handleItemActivate = useCallback(
    (itemId: string) => {
      const sid = api.activeId;
      if (!sid) return;
      const current = selectedItemBySession[sid] ?? null;
      if (current === itemId) {
        if (!isExpandableItemId(itemId)) return;
        setExpandedItems((prev) => {
          const cur = prev[sid] ?? new Set<string>();
          const next = new Set(cur);
          if (next.has(itemId)) next.delete(itemId);
          else next.add(itemId);
          return { ...prev, [sid]: next };
        });
        return;
      }
      setSelectedItemBySession((prev) => ({ ...prev, [sid]: itemId }));
    },
    [api.activeId, selectedItemBySession],
  );

  const toggleLatestDelegation = useCallback(() => {
    const sid = api.activeId;
    if (!sid) return;
    const groupId = latestDelegationId(api.active ?? null);
    if (!groupId) return;
    setExpandedItems((prev) => {
      const cur = prev[sid] ?? new Set<string>();
      const next = new Set(cur);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return { ...prev, [sid]: next };
    });
  }, [api.activeId, api.active]);

  const promptMeta = useMemo(() => {
    const s = api.active;
    if (!s) return null;
    const modelId =
      s.activeRunner === "claude"
        ? s.models.claude
        : s.activeRunner === "codex"
          ? s.models.codex
          : s.models.vercel;
    const modelLabel = prettyModelLabel(modelId, s.activeRunner);
    const projectLabel = projectName(s.cwd);
    const branch =
      s.git && s.git.branch
        ? { name: s.git.branch, dirty: s.git.dirty }
        : null;
    const delegations = s.delegations ?? null;

    // Per-turn metrics: pull straight from the most recent SDK-reported
    // turnUsage on the session. Session-level "lifetime" totals are also
    // available via sessionTotals() if we want to surface them on /context,
    // but the rail is meant to reflect the *current* turn (matches what the
    // user just sent).
    //
    // contextUsage is cleared by the server when the runner is swapped, so we
    // gate the historical In/Cache/Out pairs on it too — otherwise they'd
    // stay stuck on the previous runner's numbers after a tab-cycle until the
    // new runner emits its first turn.
    const ctx = s.contextUsage ?? null;
    const last = ctx ? lastTurnUsage(s) : null;
    const metaPairs: MetaPair[] = [];
    if (last) {
      metaPairs.push({ label: "In", value: formatTokens(last.input) });
      if (last.cacheRead > 0) {
        metaPairs.push({ label: "Cache", value: formatTokens(last.cacheRead) });
      }
      metaPairs.push({ label: "Out", value: formatTokens(last.output) });
    }
    if (ctx) {
      // One decimal so the % visibly moves turn-to-turn (rounding to int
      // makes 11.3 → "11" and 11.7 → "12" look static when the underlying
      // window load grew by a few hundred tokens).
      metaPairs.push({ label: "Ctx", value: `${ctx.percentage.toFixed(1)}%` });
    }
    const contextPercent = ctx ? Math.round(ctx.percentage) : null;
    return { modelLabel, contextPercent, projectLabel, branch, delegations, metaPairs };
  }, [api.active]);

  const sessionPill = useMemo(
    () =>
      api.active
        ? {
            name: api.active.title,
            streaming: api.sessions.filter((s) => s.streaming).length,
          }
        : null,
    [api.active, api.sessions],
  );

  const sessionItems = useMemo<PaletteItem[]>(() => {
    return api.sessions.map((s) => {
      const runnerColor =
        s.activeRunner === "claude"
          ? theme.runnerClaude
          : s.activeRunner === "codex"
            ? theme.runnerCodex
            : theme.runnerVercel;
      const detail = `${basename(s.cwd) || "~"} · ${s.activeRunner} · ${s.messages.length} msg`;
      return {
        id: s.id,
        label: s.title,
        detail,
        badge: { text: s.activeRunner, color: runnerColor },
        streaming: s.streaming,
        onActivate: () => {
          api.setActive(s.id);
          setPaletteMode(null);
        },
        actions: [
          {
            key: "d",
            label: "delete (press d again to confirm)",
            destructive: true,
            run: () => api.deleteSession(s.id),
          },
        ],
      };
    });
  }, [api.sessions, api.setActive, api.deleteSession]);

  const skillItems = useMemo<PaletteItem[]>(() => {
    if (!api.active) return [];
    const runner = api.active.activeRunner;
    const runnerColor =
      runner === "claude"
        ? theme.runnerClaude
        : runner === "codex"
          ? theme.runnerCodex
          : theme.runnerVercel;
    // Union the SDK-sourced listing (when available for the current runner)
    // with the FS walk. The Claude SDK's `system init` reports a `skills`
    // array that often only includes skills loaded into the system prompt —
    // plugin-bundled skills under ~/.claude/plugins/cache/* are sometimes
    // missing from it. Earlier we treated SDK as a replacement for FS, which
    // hid those skills as soon as a turn ran. Merging keeps them visible and
    // still lets SDK metadata (pluginName, isFsRemovable) win on overlap.
    const sid = api.activeId;
    const snap = sid ? api.sessionSkills[sid] : null;
    const sdkEntries = snap && snap.runner === runner ? snap.entries : [];

    type Row = {
      name: string;
      detail: string;
      isFsRemovable: boolean;
    };
    const byName = new Map<string, Row>();
    for (const e of skillEntries) {
      byName.set(e.name, {
        name: e.name,
        detail: e.description
          ? clipDetail(e.description, 60)
          : e.isSymlink
            ? "(symlink)"
            : "(dir)",
        isFsRemovable: e.isSymlink,
      });
    }
    for (const e of sdkEntries) {
      byName.set(e.name, {
        name: e.name,
        detail: detailForSdkSkill(e),
        isFsRemovable: e.isFsRemovable,
      });
    }
    const rows: Row[] = Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    return rows.map((row) => {
      const actions: NonNullable<PaletteItem["actions"]> = [];
      if (row.isFsRemovable) {
        actions.push({
          key: "d",
          label: "remove (press d again to confirm)",
          destructive: true,
          run: () => {
            const aid = api.activeId;
            const res = removeSkill(runner, row.name);
            if (aid) {
              addNotice(
                aid,
                "/skills remove",
                skillsLines(runner, listSkills(runner), res.ok ? `removed: ${res.name}` : `failed: ${res.error}`),
              );
            }
            setPaletteMode(null);
          },
        });
      }
      return {
        id: `${runner}:${row.name}`,
        label: row.name,
        detail: row.detail,
        badge: { text: runner, color: runnerColor },
        onActivate: () => {
          const aid = api.activeId;
          if (!aid) return;
          // Frontmatter lookup uses the bare skill name; plugin-qualified
          // names won't resolve to ~/.<runner>/skills, so the info notice
          // shows what we know (the name + source) without the body.
          const fm = readSkillFrontmatter(runner, row.name);
          addNotice(aid, "/skills info", skillInfoLines(runner, row.name, fm));
          setPaletteMode(null);
        },
        actions: actions.length > 0 ? actions : undefined,
      } satisfies PaletteItem;
    });
  }, [skillEntries, api.active?.activeRunner, api.activeId, api.sessionSkills]);

  // Skill suggestions surfaced in the prompt's slash autocomplete. Names use
  // the same source as the palette: SDK-reported when the active session has
  // one for the current runner, FS walk otherwise. Plugin-qualified names
  // (`/superpowers:brainstorming`) appear verbatim — the loosened slash regex
  // accepts the colon.
  const skillSlashSuggestions = useMemo(() => {
    if (!api.active) return [];
    const runner = api.active.activeRunner;
    const sid = api.activeId;
    const snap = sid ? api.sessionSkills[sid] : null;
    const sdkEntries = snap && snap.runner === runner ? snap.entries : [];
    const byName = new Map<string, { name: string; help: string }>();
    for (const e of skillEntries) {
      byName.set(e.name, {
        name: `/${e.name}`,
        help: e.description ? clipDetail(e.description, 60) : "skill",
      });
    }
    for (const e of sdkEntries) {
      byName.set(e.name, {
        name: `/${e.name}`,
        help: e.pluginName ? `skill (plugin: ${e.pluginName})` : "skill",
      });
    }
    return Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [api.active?.activeRunner, api.activeId, api.sessionSkills, skillEntries]);

  // Set of slash-name strings (case-insensitive) the active session
  // recognises as skills, used by handleSubmit to decide whether to forward
  // an "unknown" slash to the runner instead of showing the error notice.
  const knownSkillSlashNames = useMemo(() => {
    const out = new Set<string>();
    for (const s of skillSlashSuggestions) out.add(s.name.slice(1).toLowerCase());
    return out;
  }, [skillSlashSuggestions]);

  const mcpItems = useMemo<PaletteItem[]>(() => {
    if (!api.active) return [];
    const runner = api.active.activeRunner;
    const runnerColor =
      runner === "claude"
        ? theme.runnerClaude
        : runner === "codex"
          ? theme.runnerCodex
          : theme.runnerVercel;
    return mcpServerNames.map((name) => ({
      id: `${runner}:mcp:${name}`,
      label: name,
      detail: `mcp server (${runner})`,
      badge: { text: "mcp", color: runnerColor },
      onActivate: () => {
        const sid = api.activeId;
        if (!sid) return;
        addNotice(sid, "/mcp test", [`testing ${runner}/${name} — spawning for 2s…`]);
        testMcp(runner, name)
          .then((res) => addNotice(sid, "/mcp test", mcpTestLines(runner, name, res)))
          .catch((err) => addNotice(sid, "/mcp test", [`test crashed: ${(err as Error).message}`]));
        setPaletteMode(null);
      },
      actions: [
        {
          key: "d",
          label: "remove (press d again to confirm)",
          destructive: true,
          run: () => {
            const sid = api.activeId;
            const res = removeMcp(runner, name);
            if (sid) addNotice(sid, "/mcp remove", mcpActionLines(runner, "remove", name, res));
            setPaletteMode(null);
          },
        },
      ],
    }));
  }, [mcpServerNames, api.active?.activeRunner, api.activeId]);

  const commandItems = useMemo<PaletteItem[]>(() => {
    return SLASH_COMMANDS.map((cmd) => ({
      id: `cmd:${cmd.name}`,
      label: cmd.name,
      detail: cmd.help,
      badge: { text: "cmd", color: theme.textMuted },
      onActivate: () => {
        // For commands with arguments, drop the name into the prompt and let
        // the user finish typing. For zero-arg commands, run immediately.
        const bare = cmd.name.split(" ")[0];
        const hasArgs = cmd.name.includes("[") || cmd.name.includes("<");
        setPaletteMode(null);
        if (!hasArgs) handleSubmit(bare);
        else handleSubmit(bare); // bare form is fine for our commands — args are optional
      },
    }));
  }, []);

  function itemsForMode(mode: "sessions" | "skills" | "mcp" | "global"): PaletteItem[] {
    switch (mode) {
      case "sessions": return sessionItems;
      case "skills":   return skillItems;
      case "mcp":      return mcpItems;
      case "global":   return [...sessionItems, ...commandItems, ...skillItems];
    }
  }

  const addNotice = useCallback(
    (sessionId: string, command: string, lines: string[]) => {
      const notice = makeNotice(command, lines);
      setNotices((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), notice],
      }));
    },
    [],
  );

  const addNotification = useCallback(
    (message: string, kind: NotificationKind = "info", durationMs?: number) => {
      setNotifications((prev) => [
        ...prev,
        makeNotification(message, kind, durationMs),
      ]);
    },
    [],
  );

  // Drop expired notifications. Re-scheduled whenever the list changes so the
  // next earliest expiry drives the timer.
  useEffect(() => {
    if (notifications.length === 0) return;
    const now = Date.now();
    const earliest = Math.min(...notifications.map((n) => n.expiresAt));
    const delay = Math.max(50, earliest - now);
    const t = setTimeout(() => {
      const cutoff = Date.now();
      setNotifications((prev) => prev.filter((n) => n.expiresAt > cutoff));
    }, delay);
    return () => clearTimeout(t);
  }, [notifications]);

  // Fires on mouse-up after a drag-select (opentui's `selection` event is
  // emitted from finishSelection — see core/index-3fq5hq97.js:24423). We use
  // it as a "copy gesture complete" signal: stash the text for the cmd+c /
  // ctrl+y fallback path, and auto-copy to the system clipboard so the user
  // doesn't have to find a chord that survives their terminal's interception.
  useSelectionHandler((selection) => {
    const text = (selection.getSelectedText() ?? "").trim();
    dragSelectionRef.current = text;
    if (!text) return;
    void writeClipboard(text).then((ok) => {
      const len = text.length;
      addNotification(
        ok
          ? `copied ${len} char${len === 1 ? "" : "s"} from selection`
          : "clipboard write failed",
        ok ? "success" : "error",
        4000,
      );
    });
  });

  // Copy the active payload to the clipboard with toast feedback.
  // Cascades:
  //   1. live mouse-drag selection → copy that
  //   2. selected chat item → copy its resolved content
  //   3. otherwise → "nothing to copy" toast so the user knows the keybind fired
  const copyActive = useCallback(() => {
    const dragged = dragSelectionRef.current.trim();
    if (dragged) {
      void writeClipboard(dragged).then((ok) => {
        const len = dragged.length;
        addNotification(
          ok
            ? `copied ${len} char${len === 1 ? "" : "s"} from selection`
            : "clipboard write failed",
          ok ? "success" : "error",
          4000,
        );
      });
      return;
    }
    const id = activeSelectedItemId;
    if (!id) {
      addNotification("nothing to copy", "info", 2500);
      return;
    }
    const text = resolveItemContent(api.active ?? null, activeNotices, id);
    if (!text) {
      addNotification("nothing to copy", "info", 2500);
      return;
    }
    void writeClipboard(text).then((ok) => {
      const len = text.length;
      addNotification(
        ok
          ? `copied ${len} char${len === 1 ? "" : "s"}`
          : "clipboard write failed",
        ok ? "success" : "error",
        4000,
      );
    });
  }, [activeSelectedItemId, api.active, activeNotices, addNotification]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "k") {
      setPaletteMode((m) => (m === "global" ? null : "global"));
      return;
    }
    // shift+up / shift+down navigate the chat-item selection. The Prompt
    // input only binds plain up/down (without shift) for history, so this
    // chord is unambiguous while typing.
    if (key.shift && key.name === "up") {
      moveItemSelection("prev");
      return;
    }
    if (key.shift && key.name === "down") {
      moveItemSelection("next");
      return;
    }
    // ctrl+e: prefer expanding the selected chat item when one is selected;
    // otherwise fall back to the delegation-group toggle behavior.
    if (key.ctrl && key.name === "e") {
      if (!toggleSelectedItemExpansion()) toggleLatestDelegation();
      return;
    }
    // Copy bindings — two are wired so at least one survives terminal chord
    // interception:
    //   cmd+c (meta+c): macOS-native; iTerm2/WezTerm pass it through when
    //     "send modifier keys" is on, but Terminal.app swallows it.
    //   ctrl+y: portable fallback. Not bound by any other handler here, not
    //     a SIGINT, and most terminals pass it straight through.
    if ((key.meta && key.name === "c") || (key.ctrl && key.name === "y")) {
      copyActive();
      return;
    }
  });

  function handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const sid = api.activeId;
      switch (slash.type) {
        case "switch":
          if (api.active) {
            const from = api.active.activeRunner;
            const to = toggleRunner(from);
            api.setRunner(to);
            if (slash.rest) api.send(slash.rest);
          }
          return;
        case "claude":
        case "codex":
        case "vercel":
          api.setRunner(slash.type);
          if (slash.rest) api.send(slash.rest);
          return;
        case "help":
          if (sid) addNotice(sid, "/help", helpLines());
          return;
        case "context":
          if (sid) addNotice(sid, "/context", contextLines(api.active));
          return;
        case "sessions":
          setPaletteMode("sessions");
          return;
        case "tree": {
          if (!sid || !api.active) return;
          const depthArg = parseInt(slash.rest, 10);
          const depth = Number.isFinite(depthArg) && depthArg > 0 ? depthArg : undefined;
          try {
            addNotice(sid, "/tree", treeLines(api.active.cwd, depth));
          } catch (err) {
            addNotice(sid, "/tree", [`failed: ${(err as Error).message}`]);
          }
          return;
        }
        case "clear":
          if (sid) {
            // Drop conversation + runtime SDK threads; keep model, mode, cwd,
            // runner, title. Same session id, so notices/preferences survive
            // — we just blow away the local notice list to match the cleared
            // transcript.
            api.clearSession(sid);
            setNotices((prev) => {
              if (!(sid in prev)) return prev;
              const next = { ...prev };
              delete next[sid];
              return next;
            });
          }
          return;
        case "consensus": {
          if (!sid) return;
          // /consensus is a claude↔codex pair protocol. Reject vercel-active
          // sessions instead of silently swapping the runner.
          if (api.active?.activeRunner === "vercel") {
            addNotice(sid, "/consensus", [
              "/consensus is not available for the vercel runner.",
              "It's a claude↔codex pair protocol — switch with /claude or",
              "/codex first, then re-run /consensus.",
            ]);
            return;
          }
          const task = slash.task.trim();
          if (!task) {
            addNotice(sid, "/consensus", [
              "usage: /consensus [max=N] [producer=claude|codex] <task>",
              "Single actor/critic cycle: the producer writes one draft, the",
              "critic reviews it once, then the user picks who implements.",
              "No retries, no loop — total cost is exactly 2 LLM calls.",
              "max=N caps tool turns per call (opt-in; unset = no cap).",
              "producer= picks who writes (default: active runner).",
            ]);
            return;
          }
          api.startConsensus(task, {
            maxTurnsPerPeer: slash.maxTurnsPerPeer,
            producer: slash.producer,
          });
          return;
        }
        case "permissions": {
          if (!sid) return;
          const action = slash.action;
          switch (action.kind) {
            case "list":
              addNotice(sid, "/permissions", permissionsLines(api.rules));
              return;
            case "add": {
              if (!action.rule) {
                addNotice(sid, "/permissions add", [
                  "missing rule. example: /permissions add npm install:*",
                ]);
                return;
              }
              const norm = normalizeRule(action.rule);
              if (!norm) return;
              api.addRule(norm.rule);
              const headline = norm.rewritten
                ? `added: ${norm.rule} (from ${norm.original})`
                : `added: ${norm.rule}`;
              addNotice(
                sid,
                "/permissions add",
                permissionsLines(dedupe([...api.rules, norm.rule]), headline),
              );
              return;
            }
            case "remove": {
              if (!action.rule) {
                addNotice(sid, "/permissions remove", [
                  "missing rule. example: /permissions remove Bash(npm install:*)",
                ]);
                return;
              }
              const norm = normalizeRule(action.rule);
              const candidates = norm
                ? Array.from(new Set([action.rule.trim(), norm.rule]))
                : [action.rule.trim()];
              const hit = candidates.find((c) => api.rules.includes(c));
              if (!hit) {
                addNotice(
                  sid,
                  "/permissions remove",
                  permissionsLines(api.rules, `no rule matched: ${action.rule}`),
                );
                return;
              }
              api.removeRule(hit);
              addNotice(
                sid,
                "/permissions remove",
                permissionsLines(
                  api.rules.filter((r) => r !== hit),
                  `removed: ${hit}`,
                ),
              );
              return;
            }
            case "clear":
              api.clearRules();
              addNotice(sid, "/permissions clear", permissionsLines([], "cleared all rules"));
              return;
          }
          return;
        }
        case "model": {
          if (!sid || !api.active) return;
          const action = slash.action;
          switch (action.kind) {
            case "picker":
              setModelPicker({ runner: api.active.activeRunner });
              return;
            case "show":
              addNotice(sid, "/model", modelLines(api.active));
              return;
            case "set": {
              const runner = api.active.activeRunner;
              api.setModel(runner, action.model);
              addNotice(
                sid,
                "/model",
                modelLines(
                  { ...api.active, models: { ...api.active.models, [runner]: action.model } },
                  `${runner} → ${action.model}`,
                ),
              );
              return;
            }
            case "setRunner": {
              api.setModel(action.runner, action.model);
              addNotice(
                sid,
                "/model",
                modelLines(
                  {
                    ...api.active,
                    models: { ...api.active.models, [action.runner]: action.model },
                  },
                  `${action.runner} → ${action.model}`,
                ),
              );
              return;
            }
            case "reset": {
              const runner = api.active.activeRunner;
              api.setModel(runner, null);
              const next = { ...api.active.models };
              delete next[runner];
              addNotice(
                sid,
                "/model",
                modelLines(
                  { ...api.active, models: next },
                  `${runner} → (default)`,
                ),
              );
              return;
            }
            case "resetRunner": {
              api.setModel(action.runner, null);
              const next = { ...api.active.models };
              delete next[action.runner];
              addNotice(
                sid,
                "/model",
                modelLines(
                  { ...api.active, models: next },
                  `${action.runner} → (default)`,
                ),
              );
              return;
            }
          }
          return;
        }
        case "plan": {
          if (!sid || !api.active) return;
          const current = api.active.claudeMode;
          let next: ClaudePermissionMode;
          switch (slash.action.kind) {
            case "on":
              next = "plan";
              break;
            case "off":
              next = "default";
              break;
            case "status":
              addNotice(sid, "/plan", planLines(api.active));
              return;
            case "toggle":
            default:
              next = current === "plan" ? "default" : "plan";
              break;
          }
          if (next !== current) api.setClaudeMode(next);
          addNotice(
            sid,
            "/plan",
            planLines(
              { ...api.active, claudeMode: next },
              next === "plan" ? "plan mode enabled" : "plan mode disabled",
            ),
          );
          return;
        }
        case "skills": {
          if (!sid || !api.active) return;
          const runner = api.active.activeRunner;
          const action = slash.action;
          switch (action.kind) {
            case "list":
              setPaletteMode("skills");
              return;
            case "add": {
              if (!action.path) {
                addNotice(sid, "/skills add", [
                  "missing path. example: /skills add ~/Workspace/my-skills/my-skill",
                ]);
                return;
              }
              const res = addSkill(runner, action.path);
              if (!res.ok) {
                addNotice(sid, "/skills add", skillsLines(runner, listSkills(runner), `failed: ${res.error}`));
                return;
              }
              addNotice(
                sid,
                "/skills add",
                skillsLines(runner, listSkills(runner), `added: ${res.name} → ${res.source}`),
              );
              return;
            }
            case "import": {
              const source = action.source;
              if (!source) {
                addNotice(sid, "/skills import", [
                  "missing source runner. example: /skills import claude brainstorm",
                  "                       or: /skills import codex   (imports all)",
                ]);
                return;
              }
              if (source === runner) {
                addNotice(sid, "/skills import", [
                  `cannot import from the active runner (${runner}). switch first with /claude or /codex.`,
                ]);
                return;
              }
              if (action.name) {
                const res = importSkill(runner, source, action.name);
                addNotice(
                  sid,
                  "/skills import",
                  skillsLines(
                    runner,
                    listSkills(runner),
                    res.ok
                      ? `imported ${source}/${res.name} → ${res.sourcePath}`
                      : `failed: ${res.error}`,
                  ),
                );
                return;
              }
              const bulk = importAllSkills(runner, source);
              const headline =
                bulk.imported.length > 0
                  ? `imported ${bulk.imported.length} from ${source}` +
                    (bulk.skipped.length ? ` (skipped ${bulk.skipped.length})` : "")
                  : `nothing imported from ${source}` +
                    (bulk.skipped.length ? ` (skipped ${bulk.skipped.length})` : "");
              const lines = skillsLines(runner, listSkills(runner), headline);
              if (bulk.skipped.length > 0) {
                lines.push("", "skipped");
                const w = Math.max(...bulk.skipped.map((s) => s.name.length));
                for (const s of bulk.skipped) {
                  lines.push(`  ${s.name.padEnd(w, " ")}   ${s.reason}`);
                }
              }
              addNotice(sid, "/skills import", lines);
              return;
            }
            case "remove": {
              if (!action.name) {
                addNotice(sid, "/skills remove", [
                  "missing name. example: /skills remove a2a-delegate",
                ]);
                return;
              }
              const res = removeSkill(runner, action.name);
              if (!res.ok) {
                addNotice(sid, "/skills remove", skillsLines(runner, listSkills(runner), `failed: ${res.error}`));
                return;
              }
              addNotice(
                sid,
                "/skills remove",
                skillsLines(runner, listSkills(runner), `removed: ${res.name}`),
              );
              return;
            }
            case "info": {
              if (!action.name) {
                addNotice(sid, "/skills info", ["missing name. example: /skills info brainstorm"]);
                return;
              }
              const fm = readSkillFrontmatter(runner, action.name);
              addNotice(sid, "/skills info", skillInfoLines(runner, action.name, fm));
              return;
            }
          }
          return;
        }
        case "mcp": {
          if (!sid || !api.active) return;
          const runner = api.active.activeRunner;
          const action = slash.action;
          switch (action.kind) {
            case "list": {
              setPaletteMode("mcp");
              return;
            }
            case "add": {
              if (!action.name || !action.command) {
                addNotice(sid, "/mcp add", [
                  "usage: /mcp add <name> <command> [args...]",
                  "example: /mcp add fetch npx -y @kazuph/mcp-fetch",
                ]);
                return;
              }
              const out = addMcp(runner, action.name, action.command, action.args);
              addNotice(sid, "/mcp add", mcpActionLines(runner, "add", action.name, out));
              return;
            }
            case "remove": {
              if (!action.name) {
                addNotice(sid, "/mcp remove", ["missing name. example: /mcp remove fetch"]);
                return;
              }
              const out = removeMcp(runner, action.name);
              addNotice(sid, "/mcp remove", mcpActionLines(runner, "remove", action.name, out));
              return;
            }
            case "test": {
              if (!action.name) {
                addNotice(sid, "/mcp test", ["missing name. example: /mcp test fetch"]);
                return;
              }
              const captureSid = sid;
              const captureRunner = runner;
              addNotice(captureSid, "/mcp test", [`testing ${captureRunner}/${action.name} — spawning for 2s…`]);
              testMcp(captureRunner, action.name)
                .then((res) => {
                  addNotice(captureSid, "/mcp test", mcpTestLines(captureRunner, action.name, res));
                })
                .catch((err) => {
                  addNotice(captureSid, "/mcp test", [`test crashed: ${(err as Error).message}`]);
                });
              return;
            }
          }
          return;
        }
        case "unknown": {
          // Known skill names pass through to the runner verbatim. The
          // Claude/Codex CLIs route /<skill-name> through their Skill tool;
          // for names we don't recognise, fall back to the help notice so a
          // typo doesn't silently become a model prompt.
          if (knownSkillSlashNames.has(slash.name.toLowerCase())) {
            api.send(text);
            return;
          }
          if (sid) {
            addNotice(sid, `/${slash.name}`, [
              `unknown command. type /help for the list.`,
            ]);
          }
          return;
        }
      }
    }
    api.send(text);
  }

  // shift+tab from the prompt cycles Claude permission modes. The cycle puts
  // bypass last so a single press from default escalates to the safe option
  // (acceptEdits), never the dangerous one. Codex sessions ignore the keystroke
  // (the indicator advertises "N/A on codex").
  const cycleClaudeMode = useCallback(() => {
    if (!api.active) return;
    if (api.active.activeRunner !== "claude") return;
    const order: ClaudePermissionMode[] = [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ];
    const i = order.indexOf(api.active.claudeMode);
    const next = order[(i + 1) % order.length];
    api.setClaudeMode(next);
  }, [api.active, api.setClaudeMode]);

  // tab from the prompt rotates the active runner through claude → codex →
  // vercel → claude. Mirrors /switch but without leaving the input.
  const cycleRunner = useCallback(() => {
    if (!api.active) return;
    api.setRunner(toggleRunner(api.active.activeRunner));
  }, [api.active, api.setRunner]);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={theme.bg}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <Transcript
        session={api.active}
        notices={activeNotices}
        selectedItemId={activeSelectedItemId}
        expandedItems={activeExpandedItems}
        onItemActivate={handleItemActivate}
      />
      <Notifications items={notifications} />
      <Spinner active={api.active} />
      {api.pendingPermissions.length > 0 && (
        <PermissionPanel
          request={api.pendingPermissions[0]}
          queueSize={api.pendingPermissions.length}
          onDecision={api.respondPermission}
        />
      )}
      {api.activeId && api.consensusReady[api.activeId] && (
        <ConsensusModal
          ready={api.consensusReady[api.activeId]}
          onAction={api.consensusAction}
        />
      )}
      {modelPicker && api.active && (
        <ModelPicker
          runner={modelPicker.runner}
          currentId={api.active.models[modelPicker.runner]}
          onSelect={(modelId) => {
            if (!api.active) return;
            api.setModel(modelPicker.runner, modelId);
            if (api.activeId) {
              addNotice(
                api.activeId,
                "/model",
                modelLines(
                  {
                    ...api.active,
                    models: {
                      ...api.active.models,
                      [modelPicker.runner]: modelId,
                    },
                  },
                  `${modelPicker.runner} → ${modelId}`,
                ),
              );
            }
            setModelPicker(null);
          }}
          onReset={() => {
            if (!api.active) return;
            api.setModel(modelPicker.runner, null);
            if (api.activeId) {
              const next = { ...api.active.models };
              delete next[modelPicker.runner];
              addNotice(
                api.activeId,
                "/model",
                modelLines(
                  { ...api.active, models: next },
                  `${modelPicker.runner} → (default)`,
                ),
              );
            }
            setModelPicker(null);
          }}
          onCancel={() => setModelPicker(null)}
        />
      )}
      {paletteMode && (
        <Palette
          title={titleForMode(paletteMode)}
          placeholder={placeholderForMode(paletteMode)}
          items={itemsForMode(paletteMode)}
          onClose={() => setPaletteMode(null)}
          onCreate={paletteMode === "sessions" ? () => { api.createSession(); setPaletteMode(null); } : undefined}
          initialItemId={
            (paletteMode === "sessions" || paletteMode === "global") && api.activeId
              ? api.activeId
              : undefined
          }
          footer={
            paletteMode === "sessions"
              ? "↑↓ nav   enter switch   tab actions   ctrl+n new   esc close"
              : undefined
          }
        />
      )}
      <Prompt
        focused
        onSubmit={handleSubmit}
        locked={
          api.pendingPermissions.length > 0 ||
          modelPicker !== null ||
          paletteMode !== null ||
          (api.activeId !== null && !!api.consensusReady[api.activeId])
        }
        streaming={api.active?.streaming ?? false}
        onInterrupt={api.interrupt}
        runner={api.active?.activeRunner ?? null}
        onCycleRunner={cycleRunner}
        claudeMode={api.active?.claudeMode ?? "default"}
        onCycleClaudeMode={cycleClaudeMode}
        modelLabel={promptMeta?.modelLabel ?? null}
        contextPercent={promptMeta?.contextPercent ?? null}
        projectLabel={promptMeta?.projectLabel ?? null}
        branch={promptMeta?.branch ?? null}
        delegations={promptMeta?.delegations ?? null}
        sessionPill={sessionPill}
        slashExtras={skillSlashSuggestions}
        metaPairs={promptMeta?.metaPairs}
      />
    </box>
  );
}

function clipDetail(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function detailForSdkSkill(e: SessionSkillEntry): string {
  if (e.pluginName) return `plugin: ${e.pluginName}`;
  if (e.isFsRemovable) return "(installed)";
  // Bare names that aren't symlinks in the user's skills dir are either
  // built-in CLI skills (no SKILL.md anywhere on disk) or project-local —
  // neither is meaningfully labelled without extra IO. Mark them as "built-in"
  // so they're visually distinct from the plugin and installed entries.
  return "(built-in)";
}

function parseMcpNames(stdout: string): string[] {
  // Both runners emit name-colon-rest lines. Skip blank/heading lines.
  const names: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s/);
    if (m) names.push(m[1]);
  }
  return names;
}

function titleForMode(mode: "sessions" | "skills" | "mcp" | "global"): string {
  switch (mode) {
    case "sessions": return "switch session";
    case "skills":   return "skills";
    case "mcp":      return "mcp servers";
    case "global":   return "jump to anything";
  }
}

function placeholderForMode(mode: "sessions" | "skills" | "mcp" | "global"): string {
  switch (mode) {
    case "sessions": return "search sessions…";
    case "skills":   return "search skills…";
    case "mcp":      return "search mcp servers…";
    case "global":   return "jump to anything…";
  }
}
