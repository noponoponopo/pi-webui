import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message, PiEvent, PiSnapshot, Projection, SessionRow, TranscriptItem } from "./types";

export const emptyProjection = (): Projection => ({
  items: [],
  running: false,
  tools: {},
  queue: { steering: [], followUp: [] },
});

export function activeHistory(
  entries: SessionEntry[],
  leafId: string | null,
): TranscriptItem[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  for (let id = leafId; id && !seen.has(id);) {
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse().flatMap((entry): TranscriptItem[] => {
    if (entry.type === "message")
      return [{ id: entry.id, message: entry.message }];
    if (entry.type === "custom_message")
      return [
        {
          id: entry.id,
          message: {
            ...entry,
            role: "custom",
            timestamp: Date.parse(entry.timestamp),
          },
        },
      ];
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      return [
        {
          id: entry.id,
          message: {
            role: "custom",
            customType: entry.type,
            content: entry.summary,
            display: true,
            timestamp: Date.parse(entry.timestamp),
          },
        },
      ];
    }
    return [];
  });
}

export function messageText(message: Message): string {
  if ("summary" in message) return message.summary;
  if ("output" in message) return message.output;
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "thinking"
          ? block.thinking
          : block.type === "toolCall"
            ? `${block.name} ${JSON.stringify(block.arguments)}`
            : "",
    )
    .join("\n");
}

const completionCache = new WeakMap<TranscriptItem[], SessionRow["completion"]>();

export function completionPreview(projection?: Projection): SessionRow["completion"] {
  if (!projection || projection.running) return undefined;
  const cached = completionCache.get(projection.items);
  if (cached) return cached;
  const index = projection.items.findLastIndex(
    (item) => item.message.role === "assistant",
  );
  if (
    index <
    projection.items.findLastIndex((item) => item.message.role === "user")
  )
    return undefined;
  const message = projection.items[index]?.message;
  if (
    !message ||
    message.role !== "assistant" ||
    ["aborted", "toolUse"].includes(message.stopReason)
  )
    return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const error = message.stopReason === "error";
  const completion = {
    id: String(message.timestamp),
    text: (error ? message.errorMessage || text || "Generation failed" : text || "Completed")
      .replace(/\s+/g, " ").slice(0, 180),
    error,
  };
  completionCache.set(projection.items, completion);
  return completion;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameJson(
      (left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key],
    ),
  );
}

/** Keep unchanged saved messages referentially stable across canonical snapshots. */
export function reconcileSnapshot(previous: PiSnapshot | undefined, next: PiSnapshot): PiSnapshot {
  if (!previous) return next;
  const oldItems = previous.transcript.items;
  const items = next.transcript.items.map((item, index) => {
    const old = oldItems[index];
    return old?.id === item.id && sameJson(old.message, item.message) ? old : item;
  });
  return {
    ...next,
    transcript: {
      ...next.transcript,
      items: items.length === oldItems.length && items.every((item, index) => item === oldItems[index])
        ? oldItems : items,
    },
  };
}

/** Only adjacent deltas in the same message block can be combined. */
export function mergeMessageDeltas(previous: PiEvent | undefined, next: PiEvent): PiEvent | undefined {
  if (next.type !== "message_update") return undefined;
  const right = next.assistantMessageEvent;
  if (right.type !== "text_delta" && right.type !== "thinking_delta" && right.type !== "toolcall_delta")
    return undefined;
  if (!previous) return next;
  if (previous.type !== "message_update") return undefined;
  const left = previous.assistantMessageEvent;
  if (left.type !== right.type || !("delta" in left) || left.contentIndex !== right.contentIndex ||
      left.delta.length + right.delta.length > 64 * 1024)
    return undefined;
  return {
    ...next,
    assistantMessageEvent: { ...left, ...right, delta: left.delta + right.delta },
  };
}

export function applyEvent(previous: Projection, event: PiEvent): Projection {
  const next = { ...previous };
  switch (event.type) {
    case "agent_start":
      next.running = true;
      next.activity = undefined;
      break;
    case "agent_settled":
      next.running = false;
      next.activity = undefined;
      next.tools = Object.fromEntries(
        Object.entries(next.tools).map(([id, tool]) => [
          id,
          { ...tool, running: false },
        ]),
      );
      break;
    case "message_start":
      if (event.message.role !== "assistant") return previous;
      next.partial = event.message;
      break;
    case "message_end":
      next.items = [
        ...next.items,
        {
          id: `live-${next.items.length}-${event.message.timestamp}`,
          message: event.message,
        },
      ];
      if (event.message.role === "assistant") next.partial = undefined;
      break;
    case "message_update": {
      if (next.partial?.role !== "assistant") return previous;
      const update = event.assistantMessageEvent;
      if (!("contentIndex" in update)) return previous;
      const content = [...next.partial.content];
      const index = update.contentIndex;
      const block = content[index];
      switch (update.type) {
        case "text_start":
          content[index] = { type: "text", text: "" };
          break;
        case "thinking_start":
          content[index] = { type: "thinking", thinking: "" };
          break;
        case "text_delta":
          content[index] = {
            type: "text",
            text: (block?.type === "text" ? block.text : "") + update.delta,
          };
          break;
        case "thinking_delta":
          content[index] = {
            type: "thinking",
            thinking:
              (block?.type === "thinking" ? block.thinking : "") + update.delta,
          };
          break;
        case "text_end":
          content[index] = { type: "text", text: update.content };
          break;
        case "thinking_end":
          content[index] = { type: "thinking", thinking: update.content };
          break;
        case "toolcall_start":
          content[index] = {
            type: "toolCall",
            id: update.id,
            name: update.toolName,
            arguments: {},
          };
          break;
        case "toolcall_delta":
          if (update.toolCall) content[index] = update.toolCall;
          break;
        case "toolcall_end":
          content[index] = update.toolCall;
          break;
        default:
          return previous;
      }
      next.partial = { ...next.partial, content, usage: event.usage };
      break;
    }
    case "tool_execution_start":
      next.tools = {
        ...next.tools,
        [event.toolCallId]: {
          name: event.toolName,
          args: event.args,
          running: true,
        },
      };
      break;
    case "tool_execution_update":
      next.tools = {
        ...next.tools,
        [event.toolCallId]: {
          ...next.tools[event.toolCallId],
          name: event.toolName,
          args: event.args,
          result: event.partialResult,
          running: true,
        },
      };
      break;
    case "tool_execution_end":
      next.tools = {
        ...next.tools,
        [event.toolCallId]: {
          ...next.tools[event.toolCallId],
          name: event.toolName,
          result: event.result,
          error: event.isError,
          running: false,
        },
      };
      break;
    case "queue_update":
      next.queue = { steering: event.steering, followUp: event.followUp };
      break;
    case "compaction_start":
      next.activity = "Compacting context";
      break;
    case "compaction_end":
      next.activity = event.errorMessage;
      break;
    case "auto_retry_start":
      next.activity = `Retry ${event.attempt}/${event.maxAttempts} · ${event.errorMessage}`;
      break;
    case "auto_retry_end":
      next.activity = event.success ? undefined : event.finalError;
      break;
    default:
      return previous;
  }
  return next;
}
