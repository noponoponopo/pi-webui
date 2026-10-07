import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, LoaderCircle, Paperclip, Square } from "lucide-react";
import type { PendingSelection } from "../shared/types";
import { ErrorNotice, IconButton } from "./ui";
import { isSendKey, type SendShortcut } from "./preferences";
import type { FileDirectory, FileEntry } from "../shared/git";
import { api } from "./api";
import { completeFile, fileQuery, matchingFiles } from "./composer-text";

export function Composer({
  id,
  onSend,
  onStop,
  onRestorePending,
  restoreRequest,
  onBusyChange,
  running,
  disabled,
  toolbar,
  placeholder = "Message or run a task, / commands",
  commands = [],
  prefill,
  cwd,
  sendShortcut = "mod-enter",
}: {
  id: string;
  onSend: (text: string) => Promise<void>;
  onStop?: () => Promise<void>;
  onRestorePending?: (from?: PendingSelection) => Promise<readonly string[]>;
  restoreRequest?: { id: string; from: PendingSelection };
  onBusyChange?: (busy: boolean) => void;
  running?: boolean;
  disabled?: boolean;
  toolbar?: ReactNode;
  placeholder?: string;
  commands?: { name: string; description?: string }[];
  prefill?: { id: string; text: string; append?: boolean };
  cwd?: string;
  sendShortcut?: SendShortcut;
}) {
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem(`draft:${id}`) || "",
  );
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoreInFlight = useRef(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState(0);
  const [suggest, setSuggest] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | undefined>(undefined);
  const [cursor, setCursor] = useState(draft.length);
  const [listing, setListing] = useState<FileDirectory>();
  const [fileError, setFileError] = useState("");
  const token = cwd && suggest ? fileQuery(draft, cursor) : undefined;
  const directory = token?.directory;
  const fileChoices = token && listing && listing.path === directory
    ? matchingFiles(listing.entries, token.query)
    : [];
  const choices =
    suggest && /^\/[^\s]*$/.test(draft)
      ? commands
          .filter((item) =>
            item.name.toLowerCase().includes(draft.slice(1).toLowerCase()),
          )
          .slice(0, 8)
      : [];
  useEffect(() => {
    setListing(undefined);
    setFileError("");
    if (!cwd || directory === undefined) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api<FileDirectory>(`/files?${new URLSearchParams({ cwd, path: directory })}`)
        .then((value) => { if (active) setListing(value); })
        .catch((error) => { if (active) setFileError(error.message); });
    }, 100);
    return () => { active = false; window.clearTimeout(timer); };
  }, [cwd, directory]);
  useEffect(() => {
    sessionStorage.setItem(`draft:${id}`, draft);
  }, [draft, id]);
  useEffect(() => {
    const recovered = (event: Event) => {
      const value = (event as CustomEvent<{ id: string; text: string }>).detail;
      if (value.id === id) {
        caret.current = value.text.length;
        setDraft(value.text);
        setCursor(value.text.length);
      }
    };
    window.addEventListener("pi-webui-draft-recovered", recovered);
    return () =>
      window.removeEventListener("pi-webui-draft-recovered", recovered);
  }, [id]);
  useEffect(() => {
    if (!prefill) return;
    const current = input.current?.value || "";
    const text = prefill.append
      ? `${current}${current.trim() ? "\n\n" : ""}${prefill.text}`
      : prefill.text;
    if (prefill.append) caret.current = text.length;
    setDraft(text);
    setCursor(text.length);
  }, [prefill?.id]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${Math.min(260, Math.max(62, input.current.scrollHeight))}px`;
    if (caret.current !== undefined) {
      input.current.focus();
      input.current.setSelectionRange(caret.current, caret.current);
      caret.current = undefined;
    }
  }, [draft]);

  const send = async () => {
    if (
      pending ||
      picking ||
      restoreInFlight.current ||
      disabled ||
      !draft.trim()
    )
      return;
    const sentDraft = draft;
    setPending(true);
    setError("");
    try {
      await onSend(sentDraft);
      setDraft((current) => (current === sentDraft ? "" : current));
      if (sessionStorage.getItem(`draft:${id}`) === sentDraft)
        sessionStorage.removeItem(`draft:${id}`);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    onBusyChange?.(pending || restoring || picking);
  }, [pending, restoring, picking, onBusyChange]);
  const restorePending = async (from?: PendingSelection) => {
    if (!onRestorePending || disabled || pending || picking || restoreInFlight.current)
      return;
    restoreInFlight.current = true;
    setRestoring(true);
    setError("");
    try {
      const messages = await onRestorePending(from);
      if (messages.length) {
        const current =
          input.current?.value ?? sessionStorage.getItem(`draft:${id}`) ?? "";
        const text = [messages.join("\n\n"), current]
          .filter((value) => value.trim())
          .join("\n\n");
        sessionStorage.setItem(`draft:${id}`, text);
        window.dispatchEvent(
          new CustomEvent("pi-webui-draft-recovered", { detail: { id, text } }),
        );
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      restoreInFlight.current = false;
      setRestoring(false);
      input.current?.focus();
    }
  };
  useEffect(() => {
    if (restoreRequest) void restorePending(restoreRequest.from);
  }, [restoreRequest?.id]);
  const choose = (name: string) => {
    const text = `/${name} `;
    caret.current = text.length;
    setCursor(text.length);
    setDraft(text);
  };
  const chooseFile = (entry: FileEntry) => {
    if (!token) return;
    const result = completeFile(draft, token, entry);
    caret.current = result.cursor;
    setCursor(result.cursor);
    setDraft(result.text);
    setSelection(0);
  };
  const choiceCount = choices.length || fileChoices.length;
  const chooseSelected = () => {
    if (choices.length) choose(choices[selection]?.name ?? choices[0].name);
    else if (fileChoices.length) chooseFile(fileChoices[selection] ?? fileChoices[0]);
  };
  const attach = async () => {
    if (!cwd || disabled || pending || picking || restoring) return;
    setPicking(true);
    setError("");
    try {
      const paths = await api<string[]>("/files/pick", { cwd });
      if (!paths.length) return;
      const text = [input.current?.value || "", ...paths].filter(Boolean).join("\n");
      caret.current = text.length;
      setDraft(text);
      setCursor(text.length);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPicking(false);
      input.current?.focus();
    }
  };

  return (
    <div className="composer-wrap">
      <ErrorNotice error={error || (token ? fileError : "")} />
      <div
        className="composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setError("Use Attach files to insert the original file paths, or paste the paths as text.");
        }}
      >
        {choices.length > 0 && (
          <div className="command-list" role="listbox" aria-label="Commands">
            {choices.map((command, index) => (
              <button
                role="option"
                aria-selected={index === selection}
                key={command.name}
                type="button"
                className={index === selection ? "selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(command.name)}
              >
                <strong>/{command.name}</strong>
                <span>{command.description}</span>
              </button>
            ))}
          </div>
        )}
        {fileChoices.length > 0 && (
          <div className="command-list" role="listbox" aria-label="Files">
            {fileChoices.map((entry, index) => (
              <button
                role="option"
                aria-selected={index === selection}
                key={entry.path}
                type="button"
                className={index === selection ? "selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseFile(entry)}
              >
                <strong>{entry.name}{entry.directory ? "/" : ""}</strong>
                <span>{entry.directory ? "Folder" : entry.path}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="Message"
          value={draft}
          placeholder={placeholder}
          rows={2}
          onChange={(event) => {
            setDraft(event.target.value);
            setCursor(event.target.selectionStart);
            setSelection(0);
            setSuggest(true);
          }}
          onSelect={(event) => {
            setCursor(event.currentTarget.selectionStart);
            setSelection(0);
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              setError("Use Attach files to insert the original file paths, or paste the paths as text.");
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.altKey && event.key === "ArrowUp" && onRestorePending) {
              event.preventDefault();
              void restorePending();
              return;
            }
            if (choiceCount && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
              if (event.key === "Escape") {
                setSuggest(false);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelection(
                  (selection +
                    (event.key === "ArrowDown" ? 1 : choiceCount - 1)) %
                    choiceCount,
                );
                return;
              }
              if (event.key === "Tab" || (event.key === "Enter" && fileChoices.length > 0)) {
                event.preventDefault();
                chooseSelected();
                return;
              }
            }
            if (isSendKey(event, sendShortcut)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-toolbar">
          {cwd && (
            <IconButton
              label="Attach files"
              disabled={disabled || pending || picking || restoring}
              onClick={() => void attach()}
            >
              {picking ? <LoaderCircle size={19} className="spin" /> : <Paperclip size={19} />}
            </IconButton>
          )}
          <div className="composer-options">{toolbar}</div>
          {running && onStop && (
            <IconButton
              label="Stop"
              onClick={() => {
                void onStop().catch((error) => setError(error.message));
              }}
            >
              <Square size={16} fill="currentColor" />
            </IconButton>
          )}
          <button
            className="send-button"
            type="button"
            aria-label={running ? "Queue message" : "Send message"}
            title={running ? "Queue message" : "Send message"}
            disabled={
              disabled ||
              pending ||
              picking ||
              restoring ||
              !draft.trim()
            }
            onClick={() => void send()}
          >
            {pending ? (
              <LoaderCircle size={20} className="spin" />
            ) : (
              <ArrowUp size={23} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
