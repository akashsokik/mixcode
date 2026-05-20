import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useCompletions, useHistory } from "../state/prompt";
import { theme } from "../theme";

const ENTER_KEYS = new Set(["return", "enter", "linefeed", "kpenter"]);

function isEnterKey(name: string | undefined): boolean {
  return !!name && ENTER_KEYS.has(name);
}

type PromptProps = {
  focused: boolean;
  onUnfocus: () => void;
  onSubmit: (text: string) => void;
  hint?: string;
};

export function Prompt({ focused, onUnfocus, onSubmit, hint }: PromptProps) {
  const [text, setText] = useState("");
  const history = useHistory();
  const completions = useCompletions();

  useEffect(() => {
    const m = text.match(/(?:^|\s)@([^\s]*)$/);
    if (m) {
      if (!completions.active) completions.open(m[1]);
      else completions.setQuery(m[1]);
    } else if (completions.active) {
      completions.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    if (history.value != null) setText(history.value);
  }, [history.value]);

  useKeyboard((key) => {
    if (!focused) return;
    const isEnter = isEnterKey(key.name);

    if (key.name === "escape") {
      if (completions.active) completions.close();
      else onUnfocus();
      return;
    }

    if (completions.active) {
      if (key.name === "up") return completions.moveUp();
      if (key.name === "down") return completions.moveDown();
      if (key.name === "tab") return applyCompletion();
      if (isEnter && completions.selected) {
        applyCompletion();
        return;
      }
    }

    if (isEnter && !completions.active) {
      handleSubmit(text);
      return;
    }

    if (!completions.active) {
      if (key.name === "up") return history.movePrev();
      if (key.name === "down") return history.moveNext();
    }
  });

  function applyCompletion(): void {
    const selected = completions.selected;
    if (!selected) return;
    const next = text.replace(/(?:^|\s)@([^\s]*)$/, (match) => {
      const prefix = match.startsWith("@") ? "" : " ";
      return `${prefix}@${selected} `;
    });
    setText(next);
    completions.close();
  }

  function handleSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    history.push(trimmed);
    onSubmit(trimmed);
    setText("");
    history.reset();
  }

  const completionRows = Math.min(completions.matches.length, 6);

  return (
    <box flexDirection="column" flexShrink={0}>
      {completions.active && completions.matches.length > 0 && (
        <box
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.border}
          backgroundColor={theme.bgPanel}
          paddingLeft={1}
          paddingRight={1}
          height={completionRows + 2}
        >
          {completions.matches.slice(0, completionRows).map((m, i) => (
            <text
              key={m}
              fg={i === completions.selectedIndex ? theme.text : theme.textMuted}
            >
              {i === completions.selectedIndex ? "› " : "  "}
              {m}
            </text>
          ))}
        </box>
      )}
      <box
        flexDirection="row"
        height={3}
        borderStyle="single"
        borderColor={focused ? theme.borderFocused : theme.border}
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={focused ? theme.accent : theme.textSubtle}>{"› "}</text>
        <input
          value={text}
          onInput={setText}
          focused={focused}
          placeholder={hint ?? "ask anything — /switch flips runners"}
          flexGrow={1}
        />
      </box>
    </box>
  );
}
