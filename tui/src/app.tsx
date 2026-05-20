import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Prompt } from "./components/Prompt";
import { StatusBar } from "./components/StatusBar";
import { useSessions } from "./state/sessions";
import { parseSlash, toggleRunner } from "./util/slash";
import { theme } from "./theme";

const SIDEBAR_WIDTH = 26;

export function App() {
  const { width, height } = useTerminalDimensions();
  const api = useSessions();
  const [focus, setFocus] = useState<"prompt" | "browse">("prompt");
  const lastDeleteRef = useRef(0);

  useEffect(() => {
    if (api.status === "open" && api.sessions.length === 0) {
      api.createSession();
    }
  }, [api.status, api.sessions.length]);

  useKeyboard((key) => {
    if (focus === "prompt") return;
    if (
      key.name === "escape" ||
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
      if (slash.type === "switch" && api.active) {
        api.setRunner(toggleRunner(api.active.activeRunner));
        if (slash.rest) api.send(slash.rest);
        return;
      }
      if (slash.type === "claude" || slash.type === "codex") {
        api.setRunner(slash.type);
        if (slash.rest) api.send(slash.rest);
        return;
      }
    }
    api.send(text);
  }

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={theme.bg}>
      <Header active={api.active} />
      <box flexDirection="row" flexGrow={1}>
        <Sidebar sessions={api.sessions} activeId={api.activeId} width={SIDEBAR_WIDTH} />
        <box flexDirection="column" flexGrow={1}>
          <Transcript session={api.active} />
          <Prompt
            focused={focus === "prompt"}
            onUnfocus={() => setFocus("browse")}
            onSubmit={handleSubmit}
          />
        </box>
      </box>
      <StatusBar
        status={api.status}
        active={api.active}
        sessionCount={api.sessions.length}
        focus={focus}
      />
    </box>
  );
}
