import { useCallback, useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Transcript } from "./components/Transcript";
import { Prompt } from "./components/Prompt";
import { Spinner } from "./components/Spinner";
import { PermissionPanel } from "./components/PermissionPanel";
import { ModelPicker } from "./components/ModelPicker";
import { Palette, type PaletteItem } from "./components/Palette";
import type { ClaudePermissionMode, SessionSkillEntry } from "../../shared/events.ts";
import { useSessions } from "./state/sessions";
import { parseSlash, SLASH_COMMANDS, toggleRunner } from "./util/slash";
import {
  contextLines,
  helpLines,
  makeNotice,
  mcpActionLines,
  mcpListLines,
  mcpTestLines,
  modelLines,
  permissionsLines,
  planLines,
  sessionsLines,
  skillInfoLines,
  skillsLines,
  type Notice,
} from "./util/notice";
import { treeLines } from "./util/tree";
import { normalizeRule } from "./util/permission-rule";
import { addSkill, listSkills, readSkillFrontmatter, removeSkill, type SkillEntry } from "./util/skills";
import { addMcp, listMcp, removeMcp, testMcp } from "./util/mcp";
import { theme } from "./theme";
import { basename } from "./util/path";
import { latestDelegationId } from "./util/blocks";
import {
  contextLimit,
  latestContextTokens,
  prettyModelLabel,
  projectName,
} from "./util/status";

const EMPTY_SET: Set<string> = new Set();

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
  const [modelPicker, setModelPicker] = useState<{ runner: "claude" | "codex" } | null>(null);
  const [paletteMode, setPaletteMode] = useState<
    "sessions" | "skills" | "mcp" | "global" | null
  >(null);
  // Per-session expand set for delegation groups. Keyed by `${messageId}:${blockIndex}`,
  // matching the ids minted by groupDelegations in util/blocks.
  const [expandedDelegations, setExpandedDelegations] = useState<
    Record<string, Set<string>>
  >({});
  const [skillEntries, setSkillEntries] = useState<SkillEntry[]>([]);
  const [mcpServerNames, setMcpServerNames] = useState<string[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);

  useEffect(() => {
    if (api.status === "open" && api.sessions.length === 0) {
      api.createSession();
    }
  }, [api.status, api.sessions.length]);

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
    setExpandedDelegations((prev) => {
      const alive = new Set(api.sessions.map((s) => s.id));
      let changed = false;
      const next: Record<string, Set<string>> = {};
      for (const [id, set] of Object.entries(prev)) {
        if (alive.has(id)) next[id] = set;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [api.sessions]);

  // Skills are read from disk — cheap enough to do synchronously in an
  // effect when entering skills or global mode, or when the active runner
  // changes while a palette is open.
  useEffect(() => {
    if (!api.active) return;
    if (paletteMode !== "skills" && paletteMode !== "global") return;
    setSkillEntries(listSkills(api.active.activeRunner));
  }, [paletteMode, api.active?.activeRunner]);

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

  const activeExpanded = useMemo(
    () =>
      api.activeId
        ? expandedDelegations[api.activeId] ?? EMPTY_SET
        : EMPTY_SET,
    [expandedDelegations, api.activeId],
  );

  const activeLatestDelegationId = useMemo(
    () => latestDelegationId(api.active ?? null),
    [api.active],
  );

  const toggleLatestDelegation = useCallback(() => {
    const sid = api.activeId;
    if (!sid) return;
    const groupId = latestDelegationId(api.active ?? null);
    if (!groupId) return;
    setExpandedDelegations((prev) => {
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
      s.activeRunner === "claude" ? s.models.claude : s.models.codex;
    const modelLabel = prettyModelLabel(modelId, s.activeRunner);
    const limit = contextLimit(modelId, s.activeRunner);
    const used = latestContextTokens(s);
    const contextPercent =
      limit > 0 ? Math.round(Math.min(1, used / limit) * 100) : null;
    const projectLabel = projectName(s.cwd);
    const branch =
      s.git && s.git.branch
        ? { name: s.git.branch, dirty: s.git.dirty }
        : null;
    const delegations = s.delegations ?? null;
    return { modelLabel, contextPercent, projectLabel, branch, delegations };
  }, [api.active]);

  const sessionPill = useMemo(
    () => ({
      total: api.sessions.length,
      streaming: api.sessions.filter((s) => s.streaming).length,
    }),
    [api.sessions],
  );

  const sessionItems = useMemo<PaletteItem[]>(() => {
    return api.sessions.map((s) => {
      const runnerColor = s.activeRunner === "claude" ? theme.runnerClaude : theme.runnerCodex;
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
    const runnerColor = runner === "claude" ? theme.runnerClaude : theme.runnerCodex;
    // Prefer the SDK-sourced listing when the active session has one for the
    // current runner — that's what the agent actually sees, including
    // plugin-bundled and built-in CLI skills the FS walk can't enumerate.
    // Falls back to the FS walk during the bootstrap window (no turn yet) and
    // for Codex (no equivalent SDK stream).
    const sid = api.activeId;
    const snap = sid ? api.sessionSkills[sid] : null;
    const useSdk = !!(snap && snap.runner === runner);

    type Row = {
      name: string;
      detail: string;
      isFsRemovable: boolean;
    };
    const rows: Row[] = useSdk
      ? snap!.entries.map((e) => ({
          name: e.name,
          detail: detailForSdkSkill(e),
          isFsRemovable: e.isFsRemovable,
        }))
      : skillEntries.map((e) => ({
          name: e.name,
          detail: e.description
            ? clipDetail(e.description, 60)
            : e.isSymlink
              ? "(symlink)"
              : "(dir)",
          isFsRemovable: e.isSymlink,
        }));

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

  const mcpItems = useMemo<PaletteItem[]>(() => {
    if (!api.active) return [];
    const runner = api.active.activeRunner;
    const runnerColor = runner === "claude" ? theme.runnerClaude : theme.runnerCodex;
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

  useKeyboard((key) => {
    if (key.ctrl && key.name === "k") {
      setPaletteMode((m) => (m === "global" ? null : "global"));
      return;
    }
    // ctrl+e toggles the latest delegation group. Not part of browse mode —
    // the Prompt input doesn't bind ctrl+e, so this passes through cleanly
    // while typing.
    if (key.ctrl && key.name === "e") {
      toggleLatestDelegation();
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
            api.setRunner(toggleRunner(api.active.activeRunner));
            if (slash.rest) api.send(slash.rest);
          }
          return;
        case "claude":
        case "codex":
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
        case "unknown":
          if (sid) {
            addNotice(sid, `/${slash.name}`, [
              `unknown command. type /help for the list.`,
            ]);
          }
          return;
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
        expandedDelegations={activeExpanded}
        latestDelegationId={activeLatestDelegationId}
      />
      <Spinner active={api.active} />
      {api.pendingPermissions.length > 0 && (
        <PermissionPanel
          request={api.pendingPermissions[0]}
          queueSize={api.pendingPermissions.length}
          onDecision={api.respondPermission}
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
        locked={api.pendingPermissions.length > 0 || modelPicker !== null || paletteMode !== null}
        streaming={api.active?.streaming ?? false}
        onInterrupt={api.interrupt}
        runner={api.active?.activeRunner ?? null}
        claudeMode={api.active?.claudeMode ?? "default"}
        onCycleClaudeMode={cycleClaudeMode}
        modelLabel={promptMeta?.modelLabel ?? null}
        contextPercent={promptMeta?.contextPercent ?? null}
        projectLabel={promptMeta?.projectLabel ?? null}
        branch={promptMeta?.branch ?? null}
        delegations={promptMeta?.delegations ?? null}
        sessionPill={sessionPill}
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
