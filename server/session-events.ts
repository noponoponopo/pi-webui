import type {
  AgentSessionEvent,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import type { PiEvent, PiState } from '../shared/types';

const sessionEventTypes = new Set<string>([
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'compaction_start',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'bash_execution_update',
]);

export function sessionEntries(
  manager: Pick<SessionManager, 'getEntries' | 'getLeafId'>,
  since?: string,
) {
  const entries = manager.getEntries();
  const cursor = since === undefined ? -1 : entries.findIndex((entry) => entry.id === since);
  if (since !== undefined && cursor === -1)
    throw new Error(`Entry ${since} not found`);
  return { entries: entries.slice(cursor + 1), leafId: manager.getLeafId() };
}

export function sessionStats(
  manager: Pick<SessionManager, 'getEntries' | 'getSessionId' | 'getSessionFile'>,
  contextUsage?: PiState['contextUsage'],
): NonNullable<PiState['stats']> {
  const stats = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextUsage,
  };
  const addUsage = (usage: Usage) => {
    stats.tokens.input += usage.input;
    stats.tokens.output += usage.output;
    stats.tokens.cacheRead += usage.cacheRead;
    stats.tokens.cacheWrite += usage.cacheWrite;
    stats.cost += usage.cost.total;
  };
  for (const entry of manager.getEntries()) {
    if (entry.type === 'usage' ||
      ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage))
      addUsage(entry.usage!);
    if (entry.type !== 'message') continue;
    stats.totalMessages++;
    const message = entry.message;
    if (message.role === 'user') stats.userMessages++;
    else if (message.role === 'toolResult') {
      stats.toolResults++;
      if (message.usage) addUsage(message.usage);
    } else if (message.role === 'assistant') {
      stats.assistantMessages++;
      if (Array.isArray(message.content))
        stats.toolCalls += message.content.filter((block) => block.type === 'toolCall').length;
      addUsage(message.usage);
    }
  }
  stats.tokens.total = stats.tokens.input + stats.tokens.output +
    stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return stats;
}

/** Convert SDK events to the public JSON event shape without cumulative snapshots. */
export function toPiEvent(event: AgentSessionEvent): PiEvent | undefined {
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.type !== 'string' ||
    !sessionEventTypes.has(event.type)
  )
    return undefined;

  if (event.type !== 'message_update') return event as PiEvent;
  if (event.message.role !== 'assistant') return undefined;

  const assistantMessageEvent = event.assistantMessageEvent;
  if (assistantMessageEvent.type === 'toolcall_start') {
    const toolCall =
      assistantMessageEvent.partial.content[assistantMessageEvent.contentIndex];
    if (toolCall?.type !== 'toolCall') return undefined;
    const { partial: _partial, ...delta } = assistantMessageEvent;
    return {
      type: 'message_update',
      usage: event.message.usage,
      assistantMessageEvent: {
        ...delta,
        id: toolCall.id,
        toolName: toolCall.name,
      },
    };
  }

  if (assistantMessageEvent.type === 'toolcall_delta') {
    const toolCall = assistantMessageEvent.partial.content[assistantMessageEvent.contentIndex];
    const { partial: _partial, ...delta } = assistantMessageEvent;
    return {
      type: 'message_update',
      usage: event.message.usage,
      assistantMessageEvent: {
        ...delta,
        ...(toolCall?.type === 'toolCall' ? { toolCall: structuredClone(toolCall) } : {}),
      },
    };
  }

  if ('partial' in assistantMessageEvent) {
    const { partial: _partial, ...delta } = assistantMessageEvent;
    return {
      type: 'message_update',
      usage: event.message.usage,
      assistantMessageEvent: delta,
    };
  }

  return {
    type: 'message_update',
    usage: event.message.usage,
    assistantMessageEvent,
  };
}
