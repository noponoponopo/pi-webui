import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  ArrowDown,
  Brain,
  ChevronRight,
  FileText,
  GitFork,
  RotateCcw,
  LoaderCircle,
  MessageSquare,
  Search,
  Terminal,
} from 'lucide-react';
import type {
  Message,
  PendingSelection,
  Projection,
  TranscriptPage,
} from '../shared/types';
import { messageText } from '../shared/transcript';
import { reconcileHistory } from '../shared/display';
import {
  chatTurns,
  contextLabel,
  presentTurn,
  type ChatStep,
  type ChatTurn,
} from '../shared/chat';
import { Markdown, MarkdownCwd } from './Markdown';
import { DeferredImage, isDisplayUrl } from './DeferredContent';
import { CopyButton, Disclosure, IconButton } from './ui';

function formatMessageTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const RawMessage = memo(function RawMessage({ value }: { value: Message }) {
  const json = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <div className="entry-detail">
      <CopyButton text={json} />
      <pre>{json}</pre>
    </div>
  );
});

const textOnly = (message: Message) =>
  'content' in message
    ? typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
    : messageText(message);
const preview = (text: string) =>
  text.slice(0, 400).replace(/\s+/g, ' ').trim();

function SystemContent({
  message,
}: {
  message: Extract<Message, { role: 'system' }>;
}) {
  return (
    <>
      {'replace' in message && message.replace === true && (
        <p>Replaces the previous system prompt and tools.</p>
      )}
      {textOnly(message) && <pre>{textOnly(message)}</pre>}
      {Object.entries(message.sections ?? {}).map(([name, value]) => (
        <Disclosure
          key={name}
          summary={
            <span>
              {name}
              {value === null ? ' · removed' : ''}
            </span>
          }
        >
          {() => <pre>{value === null ? 'Section removed' : value}</pre>}
        </Disclosure>
      ))}
      {message.toolsAdded?.length ? (
        <p>
          Tools added: {message.toolsAdded.map((tool) => tool.name).join(', ')}
        </p>
      ) : null}
      {message.toolsRemoved?.length ? (
        <p>
          Tools removed:{' '}
          {message.toolsRemoved.map((tool) => tool.name).join(', ')}
        </p>
      ) : null}
    </>
  );
}

function Images({ message }: { message: Message }) {
  if (!('content' in message) || typeof message.content === 'string')
    return null;
  return (
    <>
      {message.content.map((block, index) =>
        block.type === 'image' &&
        /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) ? (
          <DeferredImage key={index} src={'url' in block && isDisplayUrl(block.url)
            ? block.url : `data:${block.mimeType};base64,${block.data}`} />
        ) : null,
      )}
    </>
  );
}

type BranchAction = (
  entryId: string,
  action: 'fork' | 'navigate_tree',
  position?: 'before' | 'at',
) => void;
function MessageActions({
  entryId,
  onBranch,
  branchDisabled,
  position = 'before',
}: {
  entryId?: string;
  onBranch?: BranchAction;
  branchDisabled?: string;
  position?: 'before' | 'at';
}) {
  if (!onBranch) return null;
  const disabledReason = !entryId || entryId.startsWith('live-')
    ? 'This message has not been saved yet'
    : branchDisabled;
  return (
    <>
      <button
        className="icon-button"
        title={disabledReason || (position === 'before' ? 'Fork before this message' : 'Fork after this message')}
        aria-label={position === 'before' ? 'Fork before this message' : 'Fork after this message'}
        disabled={Boolean(disabledReason)}
        onClick={() => onBranch(entryId!, 'fork', position)}
      >
        <GitFork size={15} />
      </button>
      <button
        className="icon-button"
        title={disabledReason || (position === 'before' ? 'Edit this message and branch' : 'Continue after this message')}
        aria-label={position === 'before' ? 'Edit this message and branch' : 'Continue after this message'}
        disabled={Boolean(disabledReason)}
        onClick={() => onBranch(entryId!, 'navigate_tree')}
      >
        <RotateCcw size={15} />
      </button>
    </>
  );
}
const Answer = memo(function Answer({
  message,
  entryId,
  onBranch,
  branchDisabled,
}: {
  message: Message;
  entryId?: string;
  onBranch?: BranchAction;
  branchDisabled?: string;
}) {
  const text = textOnly(message);
  return (
    <div className="answer">
      {text && <Markdown text={text} />}
      <Images message={message} />
      {message.role === 'assistant' && message.errorMessage && (
        <div className="error-notice">{message.errorMessage}</div>
      )}
      {message.role === 'assistant' && message.stopReason === 'aborted' && (
        <span className="muted">Stopped</span>
      )}
      {text &&
        message.role === 'assistant' &&
        message.stopReason !== 'pending' && (
          <div className="answer-actions">
            <CopyButton text={text} />
            <MessageActions
              entryId={entryId}
              onBranch={onBranch}
              branchDisabled={branchDisabled}
              position="at"
            />
          </div>
        )}
    </div>
  );
});

const ProcessRow = memo(function ProcessRow(step: ChatStep & {
  tool?: Projection['tools'][string];
}) {
  if (step.kind === 'context')
    return (
      <Disclosure
        className="process-row context-row"
        summary={
          <>
            <FileText size={15} />
            <span>{contextLabel(step.message)}</span>
            <ChevronRight className="disclosure-chevron" size={14} />
          </>
        }
      >
        {() => (
          <div className="process-content">
            {step.message.role === 'system' ? (
              <SystemContent message={step.message} />
            ) : (
              <pre>{messageText(step.message)}</pre>
            )}
          </div>
        )}
      </Disclosure>
    );
  if (step.kind !== 'tool')
    return (
      <Disclosure
        className="process-row"
        summary={
          <>
            {step.kind === 'thinking' ? (
              <Brain size={15} />
            ) : (
              <MessageSquare size={15} />
            )}
            <span>{step.kind === 'thinking' ? 'Think' : 'Assistant'}</span>
            <span className="process-preview">{preview(step.text)}</span>
            <ChevronRight className="disclosure-chevron" size={14} />
          </>
        }
      >
        {() => (
          <div className="process-content">
            <Markdown text={step.text} />
          </div>
        )}
      </Disclosure>
    );
  const tool = step.tool;
  const args = tool?.args ?? step.args;
  const failed =
    step.result?.role === 'toolResult' ? step.result.isError : tool?.error;
  const summary =
    args && typeof args === 'object'
      ? Object.entries(args)
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
          )
          .join(' · ')
      : '';
  return (
    <Disclosure
      className={`process-row ${failed ? 'failed' : ''}`}
      summary={
        <>
          {tool?.running ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Terminal size={15} />
          )}
          <span>{step.name}</span>
          <span className="process-preview">{preview(summary)}</span>
          <ChevronRight className="disclosure-chevron" size={14} />
        </>
      }
    >
      {() => {
        const output = step.result
          ? messageText(step.result)
          : tool?.result?.content
              .map((content) =>
                typeof content === 'object' && content && 'text' in content
                  ? String(content.text)
                  : '',
              )
              .join('\n');
        return (
          <div className="process-content">
            {args !== undefined && <pre>{JSON.stringify(args, null, 2)}</pre>}
            {output && <pre>{output}</pre>}
            {step.result && <Images message={step.result} />}
          </div>
        );
      }}
    </Disclosure>
  );
});

function Process({
  steps,
  progress,
  running,
  grouped,
}: {
  steps: ChatStep[];
  progress: Projection['tools'];
  running: boolean;
  grouped: boolean;
}) {
  if (!steps.length) return null;
  const rows = () => (
    <div className="work-items">
      {steps.map((step) => (
        <ProcessRow
          {...step}
          tool={step.kind === 'tool' ? progress[step.callId] : undefined}
          key={step.id}
        />
      ))}
    </div>
  );
  if (running || !grouped) return rows();
  const calls = steps.filter((step) => step.kind === 'tool').length;
  return (
    <Disclosure
      className="work-group"
      summary={
        <>
          <span>
            {calls
              ? `${calls} tool call${calls === 1 ? '' : 's'}`
              : `${steps.length} step${steps.length === 1 ? '' : 's'}`}
          </span>
          <ChevronRight className="disclosure-chevron" size={15} />
        </>
      }
    >
      {rows}
    </Disclosure>
  );
}

const Turn = memo(function Turn({
  turn,
  partial,
  running,
  progress,
  onBranch,
  branchDisabled,
}: {
  turn: ChatTurn;
  partial?: Message;
  running: boolean;
  progress: Projection['tools'];
  onBranch?: BranchAction;
  branchDisabled?: string;
}) {
  const { steps, answer } = useMemo(
    () => presentTurn(turn, partial),
    [turn, partial],
  );
  return (
    <section className="turn">
      {turn.user && (
        <div className="user-message">
          <div className="user-bubble">
            <Images message={turn.user} />
            <div className="user-text">{textOnly(turn.user)}</div>
          </div>
          <div className="message-meta">
            <time>{formatMessageTime(turn.user.timestamp)}</time>
            <CopyButton text={textOnly(turn.user)} />
            <MessageActions entryId={turn.id} onBranch={onBranch} branchDisabled={branchDisabled} />
          </div>
        </div>
      )}
      <Process
        key={running ? 'running' : 'settled'}
        steps={steps}
        progress={progress}
        running={running}
        grouped={Boolean(turn.user)}
      />
      {answer && (
        <Answer
          message={answer}
          entryId={turn.items.findLast((item) => item.message === answer)?.id}
          onBranch={onBranch}
          branchDisabled={branchDisabled}
        />
      )}
    </section>
  );
}, (previous, next) => {
  if (previous.partial !== next.partial || previous.running !== next.running ||
      previous.onBranch !== next.onBranch || previous.branchDisabled !== next.branchDisabled ||
      previous.turn.id !== next.turn.id || previous.turn.user !== next.turn.user ||
      previous.turn.items.length !== next.turn.items.length) return false;
  const sameTool = (id: string) => previous.progress[id] === next.progress[id];
  const sameProgress = (message: Message, id: string) =>
    message.role === 'assistant'
      ? message.content.every((block) => block.type !== 'toolCall' || sameTool(block.id))
      : message.role === 'toolResult'
        ? sameTool(message.toolCallId)
        : message.role !== 'bashExecution' || sameTool(id);
  if (next.partial && !sameProgress(next.partial, '')) return false;
  return previous.turn.items.every((item, index) =>
    item === next.turn.items[index] && sameProgress(item.message, item.id),
  );
});

const TranscriptBody = memo(function TranscriptBody({
  projection,
  raw = false,
  onBranch,
  branchDisabled,
  onRestorePending,
  restoreDisabled,
  search = '',
  onSearch,
}: {
  projection: Projection;
  raw?: boolean;
  onBranch?: BranchAction;
  branchDisabled?: string;
  onRestorePending?: (from: PendingSelection) => void;
  restoreDisabled?: boolean;
  search?: string;
  onSearch?: (query: string) => void;
}) {
  const grouped = useMemo(
    () => chatTurns(projection.items),
    [projection.items],
  );
  if (raw) return <Raw projection={projection} query={search} onSearch={onSearch} />;
  const visible = grouped;
  return (
    <div className="chat-column">
      {visible.map((turn, index) => {
        const last = index === visible.length - 1;
        return (
          <Turn
            key={turn.id}
            turn={turn}
            partial={last ? projection.partial : undefined}
            running={projection.running && last}
            progress={projection.tools}
            onBranch={onBranch}
            branchDisabled={branchDisabled}
          />
        );
      })}
      {!visible.length && projection.partial && (
        <Answer message={projection.partial} />
      )}
      {projection.running && (
        <div className="running-status" role="status">
          <LoaderCircle size={15} className="spin" />
          {projection.activity || 'Working'}
        </div>
      )}
      {!projection.running && projection.activity && (
        <div className="error-notice">{projection.activity}</div>
      )}
      {(projection.queue.steering.length > 0 ||
        projection.queue.followUp.length > 0) && (
        <section className="pending-messages" aria-label="Pending messages">
          {(['steering', 'followUp'] as const).flatMap((mode) =>
            projection.queue[mode].map((text, index) => (
              <div
                className="user-message pending-message"
                key={`${mode}-${index}`}
              >
                <div className="user-bubble">
                  <div className="user-text">{text}</div>
                </div>
                <div className="message-meta">
                  Pending · {mode === 'steering' ? 'Steer' : 'Follow-up'}
                  {onRestorePending && (
                    <IconButton
                      label="Restore this and later pending messages"
                      disabled={restoreDisabled}
                      onClick={() => onRestorePending({ mode, index, queue: projection.queue })}
                    >
                      <RotateCcw size={14} />
                    </IconButton>
                  )}
                </div>
              </div>
            )),
          )}
        </section>
      )}
    </div>
  );
});
function Raw({ projection, query, onSearch }: {
  projection: Projection; query: string; onSearch?: (query: string) => void;
}) {
  const items = projection.items;
  const calls = useMemo(() => projection.items.filter(
    (item) => item.message.role === 'toolResult',
  ).length, [projection.items]);
  const turns = useMemo(() => projection.items.filter(
    (item) => item.message.role === 'user',
  ).length, [projection.items]);
  const role = (message: Message) =>
    message.role === 'toolResult' || message.role === 'bashExecution'
      ? 'tool'
      : message.role === 'custom'
        ? 'context'
        : message.role;
  const history = useMemo(() => {
    const visible = items;
    return <>
      <div className="raw-timeline" aria-label="Message timeline">
        {(['input', 'agent', 'tool'] as const).map((lane) => (
          <div className="raw-lane" key={lane}>
            <span>{lane}</span>
            <div style={{ gridTemplateColumns: `repeat(${Math.max(1, visible.length)}, minmax(4px, 1fr))` }}>
              {visible.map((item, index) => {
                const itemLane = role(item.message) === 'tool'
                  ? 'tool' : item.message.role === 'assistant' ? 'agent' : 'input';
                return itemLane === lane && (
                  <button
                    className={role(item.message)}
                    key={item.id}
                    style={{ gridColumn: index + 1 }}
                    title={`${new Date(item.message.timestamp).toLocaleTimeString()} · ${role(item.message)} · ${messageText(item.message).slice(0, 100)}`}
                    aria-label={`Go to ${role(item.message)} message`}
                    onClick={() => document.getElementById(`entry-${item.id}`)?.scrollIntoView({ block: 'center' })}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {visible.map((item) => (
        <Disclosure
          className="raw-entry"
          id={`entry-${item.id}`}
          key={item.id}
          summary={
            <>
              <time title={new Date(item.message.timestamp).toLocaleString()}>
                {new Date(item.message.timestamp).toLocaleTimeString([], { hour12: false })}
              </time>
              <span className={`role-label ${role(item.message)}`}>
                {role(item.message)}
              </span>
              <span>
                {messageText(item.message).slice(0, 280) ||
                  (item.message.role === 'system'
                    ? 'System prompt and tools'
                    : item.message.role)}
              </span>
              <ChevronRight size={14} />
            </>
          }
        >
          {() => <RawMessage value={item.message} />}
        </Disclosure>
      ))}
    </>;
  }, [items]);
  return (
    <div className="raw">
      <div className="raw-toolbar">
        <span>
          {turns} turns
        </span>
        <span>{calls} calls</span>
        <label>
          <Search size={15} />
          <input
            aria-label="Search messages"
            placeholder="Search all messages"
            maxLength={200}
            value={query}
            onChange={(event) => onSearch?.(event.target.value)}
          />
        </label>
      </div>
      {history}
      {projection.partial && (
        <div className="raw-live">
          <span className="role-label assistant">assistant</span>
          <ArrowDown size={14} />
          <pre>{JSON.stringify(projection.partial, null, 2)}</pre>
        </div>
      )}
      {!items.length && (
        <p className="empty-note">
          {query ? 'No matching entries.' : 'No messages yet.'}
        </p>
      )}
    </div>
  );
}

type TranscriptProps = {
  sessionId: string;
  cwd: string;
} & ComponentProps<typeof TranscriptBody>;

// Keep chronological order while allowing live messages to replace saved versions.
function mergeItems(older: Projection['items'], newer: Projection['items']) {
  const latest = new Map(newer.map((item) => [item.id, item]));
  const ids = new Set(older.map((item) => item.id));
  return [...older.filter((item) => !item.id.startsWith('live-') || latest.has(item.id))
    .map((item) => latest.get(item.id) ?? item),
    ...newer.filter((item) => !ids.has(item.id))];
}

function TranscriptHistory({ sessionId, cwd, query, search, onSearch, ...props }: TranscriptProps & {
  query: string;
  search: string;
  onSearch: (value: string) => void;
}) {
  const [saved, setHistory] = useState<{ query: string; page: TranscriptPage }>(() => ({
    query, page: { items: props.projection.items, before: props.projection.before,
      total: props.projection.total ?? props.projection.items.length },
  }));
  const history: TranscriptPage = saved.query === query ? saved.page : { items: [], total: 0 };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ element: Element; top: number } | undefined>(undefined);
  const searched = Boolean(query && saved.query === query);

  useEffect(() => {
    if (query) return;
    setHistory((previous) => {
      const page: TranscriptPage = previous.query === query ? previous.page : { items: [], total: 0 };
      return { query, page: reconcileHistory(page, props.projection) };
    });
  }, [props.projection.items, props.projection.before, props.projection.total, query]);

  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = undefined;
    const scroll = sentinel.current?.closest('.transcript-scroll');
    if (saved?.element.isConnected && scroll) {
      scroll.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
    }
  }, [history]);

  useEffect(() => {
    setBusy(false);
    setError('');
    const marker = sentinel.current;
    const root = marker?.closest('.transcript-scroll');
    if (!marker || !root || (!history.before && (!query || searched))) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      setBusy(true);
      setError('');
      try {
        const parameters = new URLSearchParams({
          ...(history.before ? { before: history.before } : {}),
          ...(query ? { q: query } : {}),
        });
        const response = await fetch(`/api/pi/${encodeURIComponent(sessionId)}/messages?${parameters}`, {
          signal: controller.signal, cache: 'no-store',
        });
        const value: TranscriptPage & { error?: string } = await response.json();
        if (!response.ok) throw new Error(value.error || 'Could not load history');
        if (controller.signal.aborted) return;
        const element = Array.from(marker.parentElement!.querySelectorAll('.turn, .raw-entry'))
          .find((entry) => entry.getBoundingClientRect().bottom > root.getBoundingClientRect().top);
        if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
        setHistory((previous) => ({ query, page: { ...value,
          items: mergeItems(value.items, previous.query === query ? previous.page.items : []),
        } }));
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void load();
    }, { root, rootMargin: '600px 0px 0px' });
    const timer = query && !searched ? setTimeout(() => void load(), 250) : undefined;
    if (!query || searched) observer.observe(marker);
    return () => { clearTimeout(timer); observer.disconnect(); controller.abort(); };
  }, [sessionId, history.before, query, searched, retry]);

  const projection: Projection = query
    ? { ...props.projection, ...history, partial: undefined, running: false,
        activity: undefined, tools: {}, queue: { steering: [], followUp: [] } }
    : { ...props.projection, ...reconcileHistory(history, props.projection) };
  return <>
    <div ref={sentinel} className="history-status">
      {busy && <span role="status">Loading…</span>}
      {error && <span className="error-notice" role="alert">{error} <button onClick={() => setRetry((value) => value + 1)}>Retry</button></span>}
      {query && !busy && <span>{history.total} matches</span>}
    </div>
    <MarkdownCwd.Provider value={cwd}>
      <TranscriptBody {...props} projection={projection} search={search} onSearch={onSearch} />
    </MarkdownCwd.Provider>
  </>;
}

export const Transcript = memo(function Transcript(props: TranscriptProps) {
  const [search, setSearch] = useState('');
  const query = props.raw ? search : '';
  return <TranscriptHistory key={props.sessionId} {...props}
    query={query} search={search} onSearch={setSearch} />;
});
