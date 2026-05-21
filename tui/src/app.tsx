import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Prompt } from "./components/Prompt";
import { Spinner } from "./components/Spinner";
import { PermissionPanel } from "./components/PermissionPanel";
import { ModelPicker } from "./components/ModelPicker";
import type { ClaudePermissionMode } from "../../shared/events.ts";
import { useSessions } from "./state/sessions";
import { parseSlash, toggleRunner } from "./util/slash";
import {
  contextLines,
  helpLines,
  makeNotice,
  modelLines,
  permissionsLines,
  planLines,
  type Notice,
} from "./util/notice";
import { treeLines } from "./util/tree";
import { normalizeRule } from "./util/permission-rule";
import { theme } from "./theme";
import {
  contextLimit,
  latestContextTokens,
  prettyModelLabel,
  projectName,
} from "./util/status";

const SIDEBAR_WIDTH = 28;

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export function App() {
  const { width, height } = useTerminalDimensions();
  const api = useSessions();
  const [focus, setFocus] = useState<"prompt" | "browse">("prompt");
  const [notices, setNotices] = useState<Record<string, Notice[]>>({});
  // null when no picker is open. The picker captures keyboard input itself;
  // App only needs to track which runner it's for so it can keep the selected
  // model up to date if the user switches runners while it's open (closes).
  const [modelPicker, setModelPicker] = useState<{ runner: "claude" | "codex" } | null>(null);
  const lastDeleteRef = useRef(0);

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
  }, [api.sessions]);

  const activeNotices = useMemo(
    () => (api.activeId ? notices[api.activeId] ?? [] : []),
    [notices, api.activeId],
  );

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
    return { modelLabel, contextPercent, projectLabel, branch };
  }, [api.active]);

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
    if (focus === "prompt") return;
    // ctrl+b is the symmetric back-to-prompt key when already in browse mode.
    if (key.ctrl && key.name === "b") {
      setFocus("prompt");
      return;
    }
    // Esc from browse mode interrupts a streaming turn rather than refocusing.
    // It feels weird to silently swallow Esc otherwise, but jumping focus on
    // Esc was the old "browse → prompt" path and is now owned by ctrl+b.
    if (key.name === "escape") {
      if (api.active?.streaming) api.interrupt();
      return;
    }
    if (
      key.name === "return" ||
      key.name === "enter" ||
      key.name === "linefeed" ||
      key.name === "kpenter"
    ) {
      setFocus("prompt");
      return;
    }
    if (key.name === "j" || key.name === "down") return api.nextSession();
    if (key.name === "k" || key.name === "up") return api.prevSession();
    if (key.name === "n") return api.createSession();
    if (key.name === "d") {
      const now = Date.now();
      if (now - lastDeleteRef.current < 1500 && api.activeId) {
        lastDeleteRef.current = 0;
        api.deleteSession(api.activeId);
      } else {
        lastDeleteRef.current = now;
      }
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
    <box flexDirection="row" width={width} height={height} backgroundColor={theme.bg}>
      <Sidebar sessions={api.sessions} activeId={api.activeId} width={SIDEBAR_WIDTH} />
      <box flexDirection="column" flexGrow={1}>
        <box
          flexDirection="column"
          flexGrow={1}
          marginTop={1}
          marginBottom={1}
          marginLeft={2}
          marginRight={2}
        >
          <Transcript session={api.active} notices={activeNotices} />
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
          <Prompt
            focused={focus === "prompt"}
            onUnfocus={() => setFocus("browse")}
            onSubmit={handleSubmit}
            locked={api.pendingPermissions.length > 0 || modelPicker !== null}
            streaming={api.active?.streaming ?? false}
            onInterrupt={api.interrupt}
            runner={api.active?.activeRunner ?? null}
            claudeMode={api.active?.claudeMode ?? "default"}
            onCycleClaudeMode={cycleClaudeMode}
            modelLabel={promptMeta?.modelLabel ?? null}
            contextPercent={promptMeta?.contextPercent ?? null}
            projectLabel={promptMeta?.projectLabel ?? null}
            branch={promptMeta?.branch ?? null}
          />
        </box>
      </box>
    </box>
  );
}
