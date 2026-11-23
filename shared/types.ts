import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcSessionState,
  SessionMessageEntry,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

import type { ToolCall } from "@earendil-works/pi-ai";

export type Message = SessionMessageEntry["message"];
export type PiCommand =
  | Exclude<RpcCommand, { type: "fork" | "clear_queue" }>
  | { type: "clear_queue"; from?: PendingSelection }
  | (Extract<RpcCommand, { type: "fork" }> & { position?: "before" | "at" })
  | { type: "navigate_tree"; targetId: string }
  | { type: "get_history_tree" }
  | { type: "get_history_entry"; entryId: string };
type MessageUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>;
export type PiEvent =
  | Exclude<JsonAgentSessionEvent, MessageUpdate>
  | (Omit<MessageUpdate, "assistantMessageEvent"> & {
      assistantMessageEvent: MessageUpdate["assistantMessageEvent"] & {
        toolCall?: ToolCall;
      };
    })
  | RpcExtensionUIRequest
  | {
      type: "extension_error";
      error: string;
      extensionPath: string;
      event: string;
    };
export type Image = { type: "image"; data: string; mimeType: string };
export type Model = {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
};
export type Session = {
  kind?: "web" | "cli";
  id: string;
  cwd: string;
  name: string;
  updatedAt: number;
  file?: string;
  source?: string;
  hasMessages?: boolean;
};
export type SessionRow = Session & {
  running: boolean;
  waiting: boolean;
  connected?: boolean;
  completion?: { id: string; text: string; error?: boolean };
};
export type HistoryRow = {
  id?: string;
  path: string;
  cwd: string;
  name: string;
  updatedAt: number;
  hasMessages?: boolean;
};
export type TranscriptItem = { id: string; message: Message; durationMs?: number };
export type ToolProgress = {
  name: string;
  args: unknown;
  result?: { content: unknown[] };
  error?: boolean;
  running: boolean;
};
export type TranscriptPage = { items: TranscriptItem[]; before?: string; total: number };
export type Projection = {
  items: TranscriptItem[];
  before?: string;
  total?: number;
  partial?: Message;
  running: boolean;
  activity?: string;
  tools: Record<string, ToolProgress>;
  queue: { steering: readonly string[]; followUp: readonly string[] };
};
export type PendingSelection = {
  mode: keyof Projection["queue"];
  index: number;
  queue: Projection["queue"];
};
export type PiSessionStats = SessionStats & {
  apiRequests?: number;
  tokens: SessionStats["tokens"] & {
    reasoning?: number;
    reasoningEstimated?: boolean;
  };
};
export type PiState = {
  owner?: "web" | "cli";
  connected?: boolean;
  session: Session;
  loading: boolean;
  error?: string;
  model?: Model;
  models: Model[];
  thinkingLevel: RpcSessionState["thinkingLevel"];
  levels: string[];
  commands: { name: string; description?: string }[];
  stats?: PiSessionStats;
  contextUsage?: SessionStats["contextUsage"];
  dialogs: RpcExtensionUIRequest[];
  statuses: Record<string, string>;
  notice?: string;
  leafId?: string | null;
  capabilities?: {
    queueRecovery: boolean;
    queueRecoveryReason?: string;
    treeNavigation: boolean;
  };
};
export type PiSnapshot = { state: PiState; transcript: Projection };
export type PiUpdate =
  | { kind: "snapshot"; value: PiSnapshot }
  | { kind: "state"; value: PiState }
  | { kind: "event"; value: PiEvent };

export type TerminalUpdate = {
  text: string;
  reset?: boolean;
  closed: boolean;
};
