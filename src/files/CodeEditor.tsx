import { useEffect, useLayoutEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';

const externalUpdate = Annotation.define<boolean>();

export function CodeEditor({
  path,
  value,
  editable,
  wrap = false,
  onChange,
  onSave,
  onError,
}: {
  path: string;
  value: string;
  editable: boolean;
  wrap?: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
  onError: (error: unknown) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const readOnly = useRef(new Compartment());
  const wrapConfig = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSave, onError });
  callbacks.current = { onChange, onSave, onError };

  useEffect(() => {
    const language = new Compartment();
    const save = (view: EditorView) => {
      callbacks.current.onSave(view.state.doc.toString());
      return true;
    };
    const view = new EditorView({
      doc: value,
      parent: container.current!,
      extensions: [
        basicSetup,
        syntaxHighlighting(classHighlighter),
        language.of([]),
        readOnly.current.of(EditorState.readOnly.of(!editable)),
        wrapConfig.current.of(wrap ? EditorView.lineWrapping : []),
        EditorView.contentAttributes.of({ 'aria-label': `Edit ${path}` }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: save },
          { key: 'Ctrl-s', preventDefault: true, run: save },
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && update.transactions.some(
            (transaction) => transaction.docChanged && !transaction.annotation(externalUpdate),
          ))
            callbacks.current.onChange(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            color: 'var(--text)',
            backgroundColor: 'var(--raised)',
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'var(--mono)',
            fontSize: '12px',
            lineHeight: '1.6',
          },
          '.cm-content': { caretColor: 'var(--text)', padding: '10px 0' },
          '.cm-gutters': {
            backgroundColor: 'var(--sidebar)',
            color: 'var(--muted)',
            borderColor: 'var(--border)',
          },
          '.cm-activeLine, .cm-activeLineGutter': {
            backgroundColor: 'var(--hover)',
          },
          '&.cm-focused': { outline: 'none' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
            backgroundColor:
              'color-mix(in srgb, var(--accent) 25%, transparent)',
          },
          '.cm-cursor': { borderLeftColor: 'var(--text)' },
          '.cm-panels, .cm-tooltip': {
            backgroundColor: 'var(--sidebar)',
            color: 'var(--text)',
            borderColor: 'var(--border)',
          },
          '.cm-textfield': {
            backgroundColor: 'var(--raised)',
            color: 'var(--text)',
            borderColor: 'var(--border)',
          },
          '.cm-button': {
            backgroundImage: 'none',
            backgroundColor: 'var(--button)',
            color: 'var(--text)',
            borderColor: 'var(--border)',
          },
          '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
            backgroundColor: 'var(--accent)',
            color: 'var(--bg)',
          },
          '.cm-selectionMatch, .cm-matchingBracket': {
            backgroundColor:
              'color-mix(in srgb, var(--accent) 20%, transparent)',
          },
          '.cm-foldPlaceholder': {
            backgroundColor: 'var(--surface)',
            color: 'var(--muted)',
            borderColor: 'var(--border)',
          },
        }),
      ],
    });
    editor.current = view;
    view.focus();
    let active = true;
    const description = LanguageDescription.matchFilename(languages, path);
    if (description)
      void description
        .load()
        .then((support) => {
          if (active) view.dispatch({ effects: language.reconfigure(support) });
        })
        .catch((error) => {
          if (active) callbacks.current.onError(error);
        });
    return () => {
      active = false;
      view.destroy();
      editor.current = undefined;
    };
  }, [path]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [Transaction.addToHistory.of(false), externalUpdate.of(true)],
      });
  }, [value]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: readOnly.current.reconfigure(EditorState.readOnly.of(!editable)),
    });
  }, [editable]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: wrapConfig.current.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrap]);

  return <div className="code-editor" ref={container} />;
}
