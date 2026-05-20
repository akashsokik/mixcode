import { SyntaxStyle, TextAttributes } from "@opentui/core";
import type { Session, SessionMessage, ToolLog } from "../../../shared/events.ts";
import { ToolCard } from "./ToolCard";
import { theme } from "../theme";

// Shared SyntaxStyle for markdown rendering. SyntaxStyle.create() returns a
// default that <markdown> needs as a required prop.
const markdownStyle = SyntaxStyle.create();

export function Transcript({ session }: { session: Session | null }) {
  if (!session) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textSubtle}>no session selected</text>
      </box>
    );
  }

  return (
    <scrollbox
      flexGrow={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      stickyScroll
      stickyStart="bottom"
      scrollbarOptions={{ showArrows: false }}
    >
      {session.messages.length === 0 && (
        <text fg={theme.textSubtle}>
          type a prompt, prefix with /claude /codex to pick a runner
        </text>
      )}
      {session.messages.map((m, i) => (
        <Message
          key={m.id}
          message={m}
          isLast={i === session.messages.length - 1}
          streaming={session.streaming}
        />
      ))}
    </scrollbox>
  );
}

function Message({
  message,
  isLast,
  streaming,
}: {
  message: SessionMessage;
  isLast: boolean;
  streaming: boolean;
}) {
  const isUser = message.role === "user";
  const label = isUser ? "you" : "claude";

  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" height={1}>
        <text fg={isUser ? theme.textMuted : theme.accent} attributes={TextAttributes.BOLD}>
          {label.toUpperCase()}
        </text>
        {!isUser && isLast && streaming && (
          <text fg={theme.textMuted}>{"  …"}</text>
        )}
      </box>
      <box flexDirection="row" paddingLeft={2} marginTop={0}>
        <box width={1} backgroundColor={isUser ? theme.textFaint : theme.border} />
        <box flexDirection="column" paddingLeft={1} flexGrow={1}>
          {isUser ? (
            <text fg={theme.text}>{message.text}</text>
          ) : (
            <AssistantBody message={message} />
          )}
        </box>
      </box>
    </box>
  );
}

function AssistantBody({ message }: { message: SessionMessage }) {
  const tools: ToolLog[] = message.events
    .filter((e): e is { type: "tool_log"; log: ToolLog } => e.type === "tool_log")
    .map((e) => e.log);
  const errors = message.events
    .filter((e): e is { type: "error"; message: string } => e.type === "error")
    .map((e) => e.message);

  return (
    <box flexDirection="column">
      {message.text && (
        <markdown
          content={message.text}
          syntaxStyle={markdownStyle}
          fg={theme.text}
        />
      )}
      {tools.map((log, i) => (
        <ToolCard key={i} log={log} />
      ))}
      {errors.map((err, i) => (
        <text key={`err-${i}`} fg={theme.accent} attributes={TextAttributes.BOLD}>
          {`error: ${err}`}
        </text>
      ))}
    </box>
  );
}
