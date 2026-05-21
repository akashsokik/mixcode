import { useEffect, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { Session, SessionMessage, ToolLog } from "../../../shared/events.ts";
import { ToolCard } from "./ToolCard";
import { NoticeCard } from "./NoticeCard";
import { Welcome } from "./Welcome";
import { theme } from "../theme";
import { markdownStyle } from "../markdown-style";
import type { Notice } from "../util/notice";

export function Transcript({
  session,
  notices,
}: {
  session: Session | null;
  notices: Notice[];
}) {
  if (!session) {
    return <Welcome />;
  }

  type Entry =
    | { kind: "message"; at: string; message: SessionMessage }
    | { kind: "notice"; at: string; notice: Notice };

  const entries: Entry[] = [
    ...session.messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...notices.map((n) => ({ kind: "notice" as const, at: n.createdAt, notice: n })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  if (entries.length === 0) {
    return <Welcome />;
  }

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const lastMsg = session.messages[session.messages.length - 1];
  const lastMsgLen = lastMsg?.text.length ?? 0;
  const lastMsgEvents = lastMsg?.events.length ?? 0;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTo(box.scrollHeight);
  }, [
    session.messages.length,
    notices.length,
    lastMsgLen,
    lastMsgEvents,
  ]);

  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      stickyScroll
      stickyStart="bottom"
      scrollbarOptions={{ showArrows: false }}
      contentOptions={{ justifyContent: "flex-end" }}
    >
      {entries.map((e) =>
        e.kind === "message" ? (
          <Message key={e.message.id} message={e.message} />
        ) : (
          <NoticeCard key={e.notice.id} notice={e.notice} />
        ),
      )}
    </scrollbox>
  );
}

function Message({ message }: { message: SessionMessage }) {
  if (message.role === "user") return <UserMessage message={message} />;
  return <AssistantMessage message={message} />;
}

function UserMessage({ message }: { message: SessionMessage }) {
  return (
    <box flexDirection="column" marginTop={1}>
      <box
        flexDirection="row"
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.textMuted}>{"› "}</text>
        <text fg={theme.text}>{message.text}</text>
      </box>
      <Rule />
    </box>
  );
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "tool"; log: ToolLog }
  | { kind: "error"; message: string };

function blocksFromEvents(events: SessionMessage["events"]): Block[] {
  const out: Block[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  for (const ev of events) {
    if (ev.type === "text_delta") {
      buf += ev.delta;
    } else if (ev.type === "tool_log") {
      flush();
      out.push({ kind: "tool", log: ev.log });
    } else if (ev.type === "error") {
      flush();
      out.push({ kind: "error", message: ev.message });
    }
  }
  flush();
  return out;
}

function AssistantMessage({ message }: { message: SessionMessage }) {
  const blocks = blocksFromEvents(message.events);

  if (blocks.length === 0) {
    return (
      <box flexDirection="column" marginTop={1}>
        <box flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>{"• "}</text>
          <text fg={theme.textSubtle}>…</text>
        </box>
        <Rule />
      </box>
    );
  }

  return (
    <box flexDirection="column" marginTop={1}>
      {blocks.map((b, i) => {
        if (b.kind === "tool") return <ToolCard key={i} log={b.log} />;
        if (b.kind === "error") {
          return (
            <box key={i} flexDirection="row" paddingLeft={1} paddingRight={1}>
              <text fg={theme.textMuted}>{"• "}</text>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {`error: ${b.message}`}
              </text>
            </box>
          );
        }
        return (
          <box key={i} flexDirection="row" paddingLeft={1} paddingRight={1} marginTop={i === 0 ? 0 : 1}>
            <text fg={theme.textMuted}>{"• "}</text>
            <box flexGrow={1}>
              <markdown content={b.text} syntaxStyle={markdownStyle} fg={theme.text} />
            </box>
          </box>
        );
      })}
      <Rule />
    </box>
  );
}

function Rule() {
  return (
    <box
      marginTop={1}
      border={["bottom"]}
      borderStyle="single"
      borderColor={theme.border}
      height={1}
    />
  );
}
