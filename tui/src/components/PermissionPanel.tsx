import { useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
  AskUserAnnotation,
  PermissionDecision,
  PermissionRequest,
} from "../../../shared/events.ts";
import type { PermissionResponsePayload } from "../state/sessions";
import { categorizeTool, type ToolCategory } from "../util/format";
import { theme } from "../theme";

type PermissionPanelProps = {
  request: PermissionRequest;
  queueSize: number;
  onDecision: (
    requestId: string,
    decision: PermissionDecision,
    payload?: PermissionResponsePayload,
  ) => void;
};

const MAX_BODY_LINES = 6;
const MAX_LINE_CHARS = 180;

export function PermissionPanel({
  request,
  queueSize,
  onDecision,
}: PermissionPanelProps) {
  if (request.tool === "AskUserQuestion") {
    return (
      <AskUserQuestionPicker
        request={request}
        queueSize={queueSize}
        onDecision={onDecision}
      />
    );
  }
  return (
    <StandardPermissionPanel
      request={request}
      queueSize={queueSize}
      onDecision={onDecision}
    />
  );
}

function StandardPermissionPanel({
  request,
  queueSize,
  onDecision,
}: PermissionPanelProps) {
  useKeyboard((key) => {
    const name = key.name;
    if (name === "y") onDecision(request.requestId, "allow_once");
    else if (name === "a") onDecision(request.requestId, "allow_always");
    else if (name === "n" || name === "escape")
      onDecision(request.requestId, "deny");
  });

  const category = categorizeTool(request.tool);
  const accent = accentFor(category);
  const body = describeRequest(request);
  const suggestion = request.suggestions[0];

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={accent} attributes={TextAttributes.BOLD}>
          {"permission"}
        </text>
        <text fg={theme.textMuted}>{`  ${request.tool}`}</text>
        {queueSize > 1 && (
          <text fg={theme.textSubtle}>{`   (1 of ${queueSize})`}</text>
        )}
      </box>
      {request.title && <text fg={theme.text}>{request.title}</text>}
      {body.slice(0, MAX_BODY_LINES).map((line, i) => (
        <box key={i} flexDirection="row">
          <text fg={theme.textFaint}>{line.indent ? "  " : ""}</text>
          <text fg={line.muted ? theme.textMuted : theme.text}>
            {clamp(line.text, MAX_LINE_CHARS)}
          </text>
        </box>
      ))}
      {body.length > MAX_BODY_LINES && (
        <text fg={theme.textFaint}>{`  … +${body.length - MAX_BODY_LINES} more`}</text>
      )}
      {request.description && !request.title && (
        <text fg={theme.textMuted}>{clamp(request.description, MAX_LINE_CHARS)}</text>
      )}
      {suggestion && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"rule  "}</text>
          <text fg={theme.textMuted}>{suggestion}</text>
        </box>
      )}
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"["}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"y"}</text>
        <text fg={theme.textMuted}>{"] allow once   ["}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"a"}</text>
        <text fg={theme.textMuted}>{"] always   ["}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"n"}</text>
        <text fg={theme.textMuted}>{"/esc] deny"}</text>
      </box>
    </box>
  );
}

type AskQuestion = {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
};

type AskOption = {
  label: string;
  description?: string;
  preview?: string;
};

function AskUserQuestionPicker({
  request,
  queueSize,
  onDecision,
}: PermissionPanelProps) {
  const questions = useMemo(() => parseAskQuestions(request.input), [request.input]);
  const total = questions.length;

  const [currentQ, setCurrentQ] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [selections, setSelections] = useState<number[][]>(() =>
    questions.map(() => []),
  );

  const accent = theme.toolTask;
  const q = questions[currentQ];

  function submitAll(finalSelections: number[][]): void {
    const answers: Record<string, string> = {};
    const annotations: Record<string, AskUserAnnotation> = {};
    questions.forEach((question, qi) => {
      const picks = finalSelections[qi] ?? [];
      if (picks.length === 0) return;
      const labels = picks.map((i) => question.options[i]?.label ?? "").filter(Boolean);
      if (labels.length === 0) return;
      answers[question.question] = labels.join(", ");
      const preview = picks
        .map((i) => question.options[i]?.preview)
        .find((p): p is string => typeof p === "string" && p.length > 0);
      if (preview) annotations[question.question] = { preview };
    });
    if (Object.keys(answers).length === 0) {
      onDecision(request.requestId, "deny");
      return;
    }
    onDecision(request.requestId, "allow_once", {
      answers,
      annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
    });
  }

  function advanceFromSingle(optionIndex: number): void {
    const next = selections.map((s, i) => (i === currentQ ? [optionIndex] : s));
    setSelections(next);
    if (currentQ + 1 < total) {
      setCurrentQ(currentQ + 1);
      setCursor(0);
    } else {
      submitAll(next);
    }
  }

  function commitMultiSelect(): void {
    if (selections[currentQ].length === 0) return; // require at least one
    if (currentQ + 1 < total) {
      setCurrentQ(currentQ + 1);
      setCursor(0);
    } else {
      submitAll(selections);
    }
  }

  function toggleMultiSelect(optionIndex: number): void {
    setSelections((prev) =>
      prev.map((s, i) => {
        if (i !== currentQ) return s;
        return s.includes(optionIndex)
          ? s.filter((x) => x !== optionIndex)
          : [...s, optionIndex];
      }),
    );
  }

  useKeyboard((key) => {
    const name = key.name;
    if (!q) return;
    if (name === "escape") {
      onDecision(request.requestId, "deny");
      return;
    }
    if (name === "down" || name === "j") {
      setCursor((c) => Math.min(c + 1, q.options.length - 1));
      return;
    }
    if (name === "up" || name === "k") {
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if ((name === "left" || name === "backspace") && currentQ > 0) {
      setCurrentQ(currentQ - 1);
      setCursor(selections[currentQ - 1]?.[0] ?? 0);
      return;
    }
    if (q.multiSelect) {
      if (name === "space") {
        toggleMultiSelect(cursor);
        return;
      }
      if (name === "return" || name === "enter" || name === "kpenter" || name === "linefeed") {
        commitMultiSelect();
        return;
      }
    } else {
      if (
        name === "return" ||
        name === "enter" ||
        name === "kpenter" ||
        name === "linefeed" ||
        name === "right"
      ) {
        advanceFromSingle(cursor);
        return;
      }
    }
  });

  if (!q) {
    return (
      <box
        flexDirection="column"
        borderStyle="single"
        borderColor={accent}
        backgroundColor={theme.bgPanel}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <text fg={theme.textMuted}>{"AskUserQuestion: no questions found"}</text>
        <box flexDirection="row">
          <text fg={theme.textMuted}>{"["}</text>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>{"esc"}</text>
          <text fg={theme.textMuted}>{"] deny"}</text>
        </box>
      </box>
    );
  }

  const selectedSet = new Set(selections[currentQ] ?? []);
  const focusedPreview = q.options[cursor]?.preview;

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      backgroundColor={theme.bgPanel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={accent} attributes={TextAttributes.BOLD}>
          {"question"}
        </text>
        {total > 1 && (
          <text fg={theme.textSubtle}>{`   ${currentQ + 1} of ${total}`}</text>
        )}
        {queueSize > 1 && (
          <text fg={theme.textSubtle}>{`   request 1 of ${queueSize}`}</text>
        )}
      </box>
      {q.header && (
        <text fg={theme.textFaint}>{clamp(q.header, MAX_LINE_CHARS)}</text>
      )}
      <text fg={theme.text}>{clamp(q.question, MAX_LINE_CHARS)}</text>
      {q.options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = selectedSet.has(i);
        const marker = q.multiSelect
          ? isSelected
            ? "[x]"
            : "[ ]"
          : isSelected
            ? "(•)"
            : "( )";
        const fg = isCursor ? theme.accent : isSelected ? theme.text : theme.textMuted;
        return (
          <box key={i} flexDirection="row">
            <text fg={isCursor ? accent : theme.textFaint}>
              {isCursor ? "› " : "  "}
            </text>
            <text fg={fg} attributes={isCursor ? TextAttributes.BOLD : undefined}>
              {`${marker} ${clamp(opt.label, MAX_LINE_CHARS)}`}
            </text>
          </box>
        );
      })}
      {q.options[cursor]?.description && (
        <box flexDirection="row">
          <text fg={theme.textFaint}>{"  "}</text>
          <text fg={theme.textMuted}>
            {clamp(q.options[cursor]!.description!, MAX_LINE_CHARS)}
          </text>
        </box>
      )}
      {focusedPreview && (
        <box flexDirection="column">
          <text fg={theme.textFaint}>{"preview"}</text>
          {focusedPreview.split("\n").slice(0, MAX_BODY_LINES).map((line, i) => (
            <text key={i} fg={theme.textMuted}>
              {clamp(line, MAX_LINE_CHARS)}
            </text>
          ))}
        </box>
      )}
      <box flexDirection="row">
        <text fg={theme.textMuted}>{"[↑/↓] move   "}</text>
        {q.multiSelect ? (
          <>
            <text fg={theme.textMuted}>{"["}</text>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {"space"}
            </text>
            <text fg={theme.textMuted}>{"] toggle   ["}</text>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {"enter"}
            </text>
            <text fg={theme.textMuted}>
              {currentQ + 1 < total ? "] next" : "] submit"}
            </text>
          </>
        ) : (
          <>
            <text fg={theme.textMuted}>{"["}</text>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {"enter"}
            </text>
            <text fg={theme.textMuted}>
              {currentQ + 1 < total ? "] select & next" : "] select & submit"}
            </text>
          </>
        )}
        {currentQ > 0 && (
          <text fg={theme.textMuted}>{"   [←] back"}</text>
        )}
        <text fg={theme.textMuted}>{"   ["}</text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          {"esc"}
        </text>
        <text fg={theme.textMuted}>{"] cancel"}</text>
      </box>
    </box>
  );
}

function parseAskQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const qRaw of raw) {
    if (!qRaw || typeof qRaw !== "object") continue;
    const q = qRaw as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question : "";
    if (!question) continue;
    const optionsRaw = Array.isArray(q.options) ? q.options : [];
    const options: AskOption[] = [];
    for (const oRaw of optionsRaw) {
      if (!oRaw || typeof oRaw !== "object") continue;
      const o = oRaw as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label : "";
      if (!label) continue;
      options.push({
        label,
        description: typeof o.description === "string" ? o.description : undefined,
        preview: typeof o.preview === "string" ? o.preview : undefined,
      });
    }
    if (options.length === 0) continue;
    out.push({
      question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

type Line = { text: string; indent?: boolean; muted?: boolean };

function describeRequest(req: PermissionRequest): Line[] {
  const input = req.input;
  if (input == null || typeof input !== "object") {
    return input ? [{ text: String(input) }] : [];
  }
  const obj = input as Record<string, unknown>;
  const tool = req.tool.toLowerCase();

  if (tool === "bash" || tool === "shell") {
    return splitBlock(stringField(obj, "command"));
  }

  if (tool === "askuserquestion") return describeAskUserQuestion(obj);

  // Generic file/path tools.
  if (typeof obj.file_path === "string" || typeof obj.path === "string") {
    const lines: Line[] = [
      { text: stringField(obj, "file_path") || stringField(obj, "path") },
    ];
    const extra = stringField(obj, "old_string") || stringField(obj, "new_string");
    if (extra) {
      for (const l of splitBlock(extra).slice(0, 3)) {
        lines.push({ ...l, indent: true, muted: true });
      }
    }
    return lines;
  }

  if (typeof obj.pattern === "string") {
    const where = typeof obj.path === "string" ? ` in ${obj.path}` : "";
    return [{ text: `"${obj.pattern}"${where}` }];
  }
  if (typeof obj.query === "string") return [{ text: `"${obj.query}"` }];
  if (typeof obj.url === "string") return [{ text: obj.url }];

  return prettyKeyValues(obj);
}

function describeAskUserQuestion(obj: Record<string, unknown>): Line[] {
  const questions = Array.isArray(obj.questions) ? obj.questions : [];
  if (questions.length === 0) return prettyKeyValues(obj);

  const lines: Line[] = [];
  questions.forEach((qRaw, qi) => {
    if (!qRaw || typeof qRaw !== "object") return;
    const q = qRaw as Record<string, unknown>;
    const prefix = questions.length > 1 ? `${qi + 1}. ` : "";
    if (typeof q.question === "string") {
      lines.push({ text: `${prefix}${q.question}` });
    }
    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach((oRaw) => {
      if (!oRaw || typeof oRaw !== "object") return;
      const o = oRaw as Record<string, unknown>;
      if (typeof o.label === "string") {
        lines.push({ text: `• ${o.label}`, indent: true, muted: true });
      }
    });
  });
  return lines;
}

function prettyKeyValues(obj: Record<string, unknown>): Line[] {
  const out: Line[] = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push({ text: `${k}: ${oneLineValue(v)}`, muted: true });
  }
  return out;
}

function oneLineValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return clamp(v.replace(/\s+/g, " ").trim(), 140);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return clamp(JSON.stringify(v), 140);
  } catch {
    return "[unserializable]";
  }
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function splitBlock(text: string): Line[] {
  if (!text) return [];
  return text.split("\n").map((t) => ({ text: t || " " }));
}

function clamp(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function accentFor(c: ToolCategory): string {
  switch (c) {
    case "edit":
      return theme.toolEdit;
    case "bash":
      return theme.toolBash;
    case "web":
      return theme.toolWeb;
    case "task":
      return theme.toolTask;
    case "read":
      return theme.toolRead;
    default:
      return theme.accentDim;
  }
}
