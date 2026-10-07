import type { Message, TranscriptItem } from './types';

export type ChatTurn = { id: string; user?: Message; items: TranscriptItem[] };
export type ChatStep =
  | { id: string; kind: 'thinking' | 'text'; text: string }
  | { id: string; kind: 'context'; message: Message }
  | {
      id: string;
      kind: 'tool';
      name: string;
      args: unknown;
      callId: string;
      result?: Message;
    };

export function chatTurns(items: TranscriptItem[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const item of items) {
    if (item.message.role === 'user' || !turns.length) {
      turns.push({
        id: item.id,
        user: item.message.role === 'user' ? item.message : undefined,
        items: [],
      });
    }
    if (item.message.role !== 'user') turns.at(-1)!.items.push(item);
  }
  return turns;
}

export function presentTurn(turn: ChatTurn, partial?: Message) {
  const items = partial
    ? [...turn.items, { id: `${turn.id}-partial`, message: partial }]
    : turn.items;
  const tail = items.findLast((item) => item.message.role === 'assistant');
  const message = tail?.message;
  const answer =
    message?.role === 'assistant' &&
    !message.content.some((block) => block.type === 'toolCall') &&
    (message.content.some((block) => block.type === 'text') ||
      message.errorMessage ||
      message.stopReason === 'aborted')
      ? message
      : undefined;
  const results = new Map(
    items.flatMap((item) =>
      item.message.role === 'toolResult'
        ? [[item.message.toolCallId, item.message] as const]
        : [],
    ),
  );
  const calls = new Set<string>();
  const steps: ChatStep[] = [];
  for (const { id, message } of items) {
    if (message.role === 'assistant') {
      message.content.forEach((block, index) => {
        const key = `${id}-${index}`;
        if (block.type === 'thinking')
          steps.push({ id: key, kind: 'thinking', text: block.thinking });
        if (block.type === 'text' && message !== answer && block.text)
          steps.push({ id: key, kind: 'text', text: block.text });
        if (block.type === 'toolCall') {
          calls.add(block.id);
          steps.push({
            id: key,
            kind: 'tool',
            name: block.name,
            args: block.arguments,
            callId: block.id,
            result: results.get(block.id),
          });
        }
      });
    } else if (message.role === 'toolResult') {
      if (!calls.has(message.toolCallId))
        steps.push({
          id,
          kind: 'tool',
          name: message.toolName,
          args: undefined,
          callId: message.toolCallId,
          result: message,
        });
    } else if (message.role === 'bashExecution') {
      steps.push({
        id,
        kind: 'tool',
        name: 'bash',
        args: { command: message.command },
        callId: id,
        result: message,
      });
    } else if (message.role !== 'custom' || message.display) {
      // Compaction summaries describe model context, not additional assistant replies.
      steps.push({ id, kind: 'context', message });
    }
  }
  return { steps, answer };
}

export function contextLabel(message: Message): string {
  if (message.role === 'system') return 'System prompt';
  if (
    message.role === 'compactionSummary' ||
    (message.role === 'custom' && message.customType === 'compaction')
  )
    return 'Context compacted';
  if (
    message.role === 'branchSummary' ||
    (message.role === 'custom' && message.customType === 'branch_summary')
  )
    return 'Branch summary';
  return message.role === 'custom' ? message.customType : 'Context';
}
