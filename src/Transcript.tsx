import { memo, useMemo, useState } from 'react';
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
} from '../shared/types';
import { messageText } from '../shared/transcript';
import {
  chatTurns,
  contextLabel,
  presentTurn,
  type ChatStep,
  type ChatTurn,
} from '../shared/chat';
import { Markdown } from './Markdown';
import { CopyButton, Disclosure, IconButton } from './ui';

const RawMessage = memo(function RawMessage({ value }: { value: unknown }) {
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
          <img
            key={index}
            className="message-image"
            loading="lazy"
            src={`data:${block.mimeType};base64,${block.data}`}
            alt="Attached image"
          />
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
        title={disabledReason || 'Fork from this message'}
        aria-label="Fork from this message"
        disabled={Boolean(disabledReason)}
        onClick={() => onBranch(entryId!, 'fork', position)}
      >
        <GitFork size={15} />
      </button>
      <button
        className="icon-button"
        title={disabledReason || 'Continue from this message'}
        aria-label="Continue from this message"
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

function ProcessRow({
  step,
  progress,
}: {
  step: ChatStep;
  progress: Projection['tools'];
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
  const tool = progress[step.callId];
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
}

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
        <ProcessRow step={step} progress={progress} key={step.id} />
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
            <time>
              {new Date(turn.user.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
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
});

export function Transcript({
  projection,
  raw = false,
  onBranch,
  branchDisabled,
  onRestorePending,
  restoreDisabled,
}: {
  projection: Projection;
  raw?: boolean;
  onBranch?: BranchAction;
  branchDisabled?: string;
  onRestorePending?: (from: PendingSelection) => void;
  restoreDisabled?: boolean;
}) {
  const [limit, setLimit] = useState(40);
  const grouped = useMemo(
    () => chatTurns(projection.items),
    [projection.items],
  );
  if (raw) return <Raw projection={projection} />;
  const visible = grouped.slice(-limit);
  return (
    <div className="chat-column">
      {grouped.length > limit && (
        <button className="load-older" onClick={() => setLimit(limit + 40)}>
          Load earlier messages
        </button>
      )}
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
}
function Raw({ projection }: { projection: Projection }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(150);
  const items = useMemo(
    () =>
      projection.items.filter((item) =>
        JSON.stringify(item.message)
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [projection.items, query],
  );
  const visible = items.slice(-limit);
  const calls = projection.items.filter(
    (item) => item.message.role === 'toolResult',
  ).length;
  const role = (message: Message) =>
    message.role === 'toolResult' || message.role === 'bashExecution'
      ? 'tool'
      : message.role === 'custom'
        ? 'context'
        : message.role;
  return (
    <div className="raw">
      <div className="raw-toolbar">
        <span>
          {
            projection.items.filter((item) => item.message.role === 'user')
              .length
          }{' '}
          turns
        </span>
        <span>{calls} calls</span>
        <label>
          <Search size={15} />
          <input
            aria-label="Search messages"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
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
      {items.length > limit && (
        <button className="load-older" onClick={() => setLimit(limit + 150)}>
          Load earlier entries
        </button>
      )}
      {visible.map((item) => (
        <Disclosure
          className="raw-entry"
          id={`entry-${item.id}`}
          key={item.id}
          summary={
            <>
              <time>
                {new Date(item.message.timestamp).toLocaleTimeString([], {
                  hour12: false,
                })}
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
