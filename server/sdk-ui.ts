import { randomUUID } from 'node:crypto';
import {
  Theme,
  type ExtensionUIContext,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from '@earendil-works/pi-coding-agent';

type DialogKind = 'select' | 'confirm' | 'input' | 'editor';

export const noColorTheme = new Theme(
  Object.fromEntries(
    'accent border borderAccent borderMuted success error warning muted dim text thinkingText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode'
      .split(' ')
      .map((token) => [token, '']),
  ) as ConstructorParameters<typeof Theme>[0],
  Object.fromEntries(
    'selectedBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg'
      .split(' ')
      .map((token) => [token, '']),
  ) as ConstructorParameters<typeof Theme>[1],
  'truecolor',
  { name: 'web-no-color', appearance: 'dark' },
);
type UIRequest = RpcExtensionUIRequest extends infer Request
  ? Request extends { type: 'extension_ui_request'; id: string }
    ? Omit<Request, 'type' | 'id'>
    : never
  : never;
type PendingDialog = {
  method: DialogKind;
  fallback: unknown;
  options?: string[];
  resolve(value: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

export class SdkUI {
  readonly context: ExtensionUIContext;
  private readonly pending = new Map<string, PendingDialog>();
  private disposed = false;
  private editorText = '';

  constructor(
    private readonly emit: (event: RpcExtensionUIRequest) => void,
    private readonly onFinish: (id: string) => void,
    theme: ExtensionUIContext['theme'] = noColorTheme,
  ) {
    const ask = <T>(
      request: UIRequest,
      method: DialogKind,
      fallback: T,
      options?: string[],
      timeout?: number,
      signal?: AbortSignal,
    ): Promise<T> => {
      if (this.disposed || signal?.aborted) return Promise.resolve(fallback);

      const id = randomUUID();
      return new Promise<T>((resolve) => {
        const pending: PendingDialog = {
          method,
          fallback,
          options,
          resolve: (value) => resolve(value as T),
          signal,
        };
        const finish = (value: unknown) => {
          if (!this.pending.delete(id)) return;
          if (pending.timer) clearTimeout(pending.timer);
          if (pending.abort)
            signal?.removeEventListener('abort', pending.abort);
          this.onFinish(id);
          pending.resolve(value);
        };
        pending.abort = () => finish(fallback);
        this.pending.set(id, pending);
        if (timeout !== undefined)
          pending.timer = setTimeout(() => finish(fallback), timeout);
        signal?.addEventListener('abort', pending.abort, { once: true });
        try {
          this.emit({
            type: 'extension_ui_request',
            id,
            ...request,
          } as RpcExtensionUIRequest);
        } catch {
          finish(fallback);
        }
      });
    };

    const send = (request: UIRequest) => {
      if (this.disposed) return;
      try {
        this.emit({
          type: 'extension_ui_request',
          id: randomUUID(),
          ...request,
        } as RpcExtensionUIRequest);
      } catch {
        // UI notifications must not fail extension handlers.
      }
    };

    this.context = {
      select: (title, options, opts) =>
        ask(
          { method: 'select', title, options },
          'select',
          undefined,
          options,
          opts?.timeout,
          opts?.signal,
        ),
      confirm: (title, message, opts) =>
        ask(
          { method: 'confirm', title, message },
          'confirm',
          false,
          undefined,
          opts?.timeout,
          opts?.signal,
        ),
      input: (title, placeholder, opts) =>
        ask(
          { method: 'input', title, placeholder },
          'input',
          undefined,
          undefined,
          opts?.timeout,
          opts?.signal,
        ),
      notify: (message, notifyType = 'info') =>
        send({ method: 'notify', message, notifyType }),
      onTerminalInput: () => () => {},
      setStatus: (statusKey, statusText) =>
        send({ method: 'setStatus', statusKey, statusText }),
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (widgetKey, content, options) => {
        if (typeof content === 'function') return;
        send({
          method: 'setWidget',
          widgetKey,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => send({ method: 'setTitle', title }),
      custom: async <T>(): Promise<T> => {
        throw new Error('Custom extension UI is not supported in web mode');
      },
      pasteToEditor: (text) => this.setEditorText(text),
      setEditorText: (text) => this.setEditorText(text),
      getEditorText: () => this.editorText,
      editor: (title, prefill) =>
        ask({ method: 'editor', title, prefill }, 'editor', undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: 'Themes are unavailable in web mode.',
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  respond(response: RpcExtensionUIResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;

    let value: unknown = pending.fallback;
    if ('cancelled' in response && response.cancelled) {
      value = pending.fallback;
    } else if (pending.method === 'confirm' && 'confirmed' in response) {
      value = response.confirmed;
    } else if (pending.method !== 'confirm' && 'value' in response) {
      if (
        pending.method === 'select' &&
        !pending.options?.includes(response.value)
      )
        return false;
      value = response.value;
    } else {
      return false;
    }

    if (!this.pending.delete(response.id)) return false;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort)
      pending.signal?.removeEventListener('abort', pending.abort);
    this.onFinish(response.id);
    pending.resolve(value);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, pending] of this.pending) {
      if (!this.pending.delete(id)) continue;
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.abort)
        pending.signal?.removeEventListener('abort', pending.abort);
      this.onFinish(id);
      pending.resolve(pending.fallback);
    }
  }

  private setEditorText(text: string): void {
    this.editorText = text;
    if (!this.disposed) {
      try {
        this.emit({
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'set_editor_text',
          text,
        });
      } catch {
        // Editor prefill is best-effort when no browser is connected.
      }
    }
  }
}
