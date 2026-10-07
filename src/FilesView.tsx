import { useEffect, useRef, useState } from "react";
import {
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type {
  FileEntry,
  GitChangedFile,
  GitCommitResult,
  GitFile,
  GitFileSaveResult,
  GitMutationResult,
  GitStatus,
} from "../shared/git";
import { api } from "./api";
import { ErrorNotice, IconButton, Modal } from "./ui";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";
import { ResizableSplit } from "./ResizableSplit";
import "./git.css";

type FileDraft = { file: GitFile; text: string };

export function FilesView({
  cwd,
  onStatusChange,
  onBusyChange,
  branchGeneration = 0,
  branchBusy = false,
  wrap = false,
}: {
  cwd: string;
  onStatusChange?: (status: GitStatus) => void;
  onBusyChange?: (busy: boolean) => void;
  branchGeneration?: number;
  branchBusy?: boolean;
  wrap?: boolean;
}) {
  const [activeCwd, setActiveCwd] = useState(cwd);
  const [status, setStatus] = useState<GitStatus>();
  const [documents, setDocuments] = useState<Map<string, FileDraft>>(new Map());
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [changesOnly, setChangesOnly] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [reviewedFileVersions, setReviewedFileVersions] = useState<
    Map<string, string>
  >(new Map());
  const [file, setFile] = useState<GitFile>();
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reviewStale, setReviewStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<FileEntry>();
  const [deleteError, setDeleteError] = useState('');
  const busy = Boolean(busyAction) || branchBusy;
  const [refresh, setRefresh] = useState(0);
  const unsavedPaths = new Set(
    [...documents].filter(([, item]) => isModified(item)).map(([path]) => path),
  );
  const dirty = Boolean(file && unsavedPaths.has(file.path));
  const dirtyRef = useRef(false);
  dirtyRef.current = unsavedPaths.size > 0;
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  const rootRef = useRef(activeCwd);
  rootRef.current = activeCwd;
  const savingRef = useRef(false);
  const statusChangeRef = useRef(onStatusChange);
  statusChangeRef.current = onStatusChange;
  const cwdRef = useRef(cwd);
  const branchGenerationRef = useRef(branchGeneration);
  const branchBlocked = loading || Boolean(busyAction) || saving || Boolean(deleting) || unsavedPaths.size > 0;

  useEffect(() => {
    onBusyChange?.(branchBlocked);
  }, [branchBlocked, onBusyChange]);

  useEffect(() => {
    if (branchGenerationRef.current === branchGeneration) return;
    branchGenerationRef.current = branchGeneration;
    documentsRef.current = new Map();
    setDocuments(new Map());
    setFile(undefined);
    setDraft("");
    setReviewedFileVersions(new Map());
    setConflict(false);
    setReviewStale(false);
    setNotice("");
    setRefresh((value) => value + 1);
  }, [branchGeneration]);

  useEffect(() => {
    if (cwdRef.current === cwd) return;
    cwdRef.current = cwd;
    setActiveCwd(cwd);
    setDeleting(undefined);
    setDeleteError('');
    setStatus(undefined);
    setLoading(true);
    setSelectedPath("");

    setReviewedFileVersions(new Map());
    setFile(undefined);
    setDraft("");
    documentsRef.current = new Map();
    setDocuments(new Map());
    setConflict(false);
    setReviewStale(false);
    setError("");
    setNotice("");
    setCommitMessage("");
  }, [cwd]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api<GitStatus>(`/git?${new URLSearchParams({ cwd: activeCwd })}`)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        statusChangeRef.current?.(next);
        if (next.isRepo && next.root !== activeCwd) setActiveCwd(next.root);
        if (!next.isRepo) setChangesOnly(false);
      })
      .catch((reason) => {
        if (active) setError(fileRequestError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeCwd, refresh]);

  useEffect(() => {
    setChangesOnly(false);
  }, [activeCwd]);

  useEffect(() => {
    let active = true;
    if (!selectedPath) {
      setFile(undefined);
      setLoadingFile(false);
      return;
    }
    const cached = documentsRef.current.get(selectedPath);
    setFile(cached?.file);
    setDraft(cached?.text ?? "");
    setConflict(false);
    if (cached && isModified(cached)) {
      setLoadingFile(false);
      return;
    }
    setLoadingFile(true);
    setError("");
    const params = new URLSearchParams({ cwd: activeCwd, path: selectedPath });
    void api<GitFile>(`/files/file?${params}`)
      .then((next) => {
        if (!active || isModified(documentsRef.current.get(selectedPath)))
          return;
        setFile(next);
        setDraft(next.content ?? "");
        setDocuments((current) => {
          const updated = new Map(current).set(next.path, {
            file: next,
            text: next.content ?? "",
          });
          documentsRef.current = updated;
          return updated;
        });
        setReviewedFileVersions((current) =>
          new Map(current).set(next.path, next.worktreeVersion),
        );
      })
      .catch((reason) => {
        if (active) setError(fileRequestError(reason));
      })
      .finally(() => {
        if (active) setLoadingFile(false);
      });
    return () => {
      active = false;
    };
  }, [activeCwd, refresh, selectedPath, status]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const refreshStatus = () => {
    setReviewStale(false);
    setError("");
    setNotice("");
    setRefresh((value) => value + 1);
  };

  const selectFile = (path: string) => {
    if (path === selectedPath) return;
    setDraft("");
    setFile(undefined);
    setConflict(false);
    setError("");
    setSelectedPath(path);
    setShowDiff(changesOnly);
  };

  const changeDraft = (text: string) => {
    if (!file) return;
    setDraft(text);
    setDocuments((current) => {
      const next = new Map(current).set(file.path, { file, text });
      documentsRef.current = next;
      return next;
    });
  };

  const save = async (value = draft) => {
    if (!file?.editable || !file.version || savingRef.current || busy)
      return;
    const text = normalizeLines(value);
    if (text === normalizeLines(file.content ?? "")) return;
    const target = file;
    const root = activeCwd;
    const content =
      target.lineEnding === "crlf" ? text.replace(/\n/g, "\r\n") : text;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await api<GitFileSaveResult>("/files/file", {
        cwd: root,
        path: target.path,
        content,
        expectedVersion: target.version,
      });
      if (rootRef.current !== root) return;
      const baseline = {
        ...target,
        content,
        version: saved.version,
        worktreeVersion: saved.worktreeVersion ?? null,
      };
      setReviewedFileVersions((current) =>
        new Map(current).set(target.path, baseline.worktreeVersion),
      );
      setDocuments((current) => {
        const next = new Map(current);
        const currentDraft = next.get(target.path);
        if (currentDraft)
          next.set(target.path, { ...currentDraft, file: baseline });
        documentsRef.current = next;
        return next;
      });
      if (selectedRef.current === target.path) {
        setFile(baseline);
        setConflict(false);
      }
      setRefresh((value) => value + 1);
    } catch (reason) {
      if (rootRef.current !== root) return;
      const message = fileRequestError(reason);
      if (
        selectedRef.current === target.path &&
        message.includes("changed since it was opened")
      )
        setConflict(true);
      else setError(`${target.path}: ${message}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const discardAndReload = () => {
    if (dirty && !window.confirm("Discard your unsaved edit and reload?"))
      return;
    setDraft("");
    setDocuments((current) => {
      const next = new Map(current);
      next.delete(selectedPath);
      documentsRef.current = next;
      return next;
    });
    setConflict(false);
    setError("");
    setFile(undefined);
    setRefresh((value) => value + 1);
  };

  const entryAction = async (entry: FileEntry, action: 'reveal' | 'delete') => {
    if (busy || saving) return;
    if (action === 'delete') {
      setDeleteError('');
      setDeleting(entry);
      return;
    }
    setError('');
    try {
      await api('/files/reveal', { cwd: activeCwd, path: entry.path });
    } catch (reason) {
      setError(fileRequestError(reason));
    }
  };

  const deleteEntry = async () => {
    if (!deleting || busy || saving) return;
    const target = deleting;
    const root = activeCwd;
    const affected = (path: string) => path === target.path || (target.directory && path.startsWith(`${target.path}/`));
    setBusyAction('delete');
    setDeleteError('');
    try {
      await api('/files/delete', { cwd: root, path: target.path, confirmed: true });
      if (rootRef.current !== root) return;
      setDocuments((current) => {
        const next = new Map([...current].filter(([path]) => !affected(path)));
        documentsRef.current = next;
        return next;
      });
      setReviewedFileVersions((current) => new Map([...current].filter(([path]) => !affected(path))));
      if (affected(selectedRef.current)) {
        setSelectedPath('');
        setFile(undefined);
        setDraft('');
        setConflict(false);
      }
      setDeleting(undefined);
      refreshStatus();
      setNotice(`Moved ${target.path} to the trash`);
    } catch (reason) {
      if (rootRef.current === root) setDeleteError(fileRequestError(reason));
    } finally {
      setBusyAction('');
    }
  };

  const stagedCount = status?.isRepo
    ? status.files.filter(hasIndexChange).length
    : 0;

  const mutateSelection = async (
    action: "stage" | "unstage",
    paths: string[],
  ) => {
    if (!status?.isRepo || !paths.length || dirtyRef.current || reviewStale || busy)
      return;
    setBusyAction(action);
    setError("");
    setNotice("");
    try {
      await api<GitMutationResult>(`/git/${action}`, {
        cwd: activeCwd,
        paths,
        expectedIndexVersion: status.indexVersion,
        ...(action === "stage"
          ? {
              expectedFiles: paths.flatMap((path) => {
                const version = reviewedFileVersions.get(path);
                return version ? [{ path, version }] : [];
              }),
            }
          : {}),
      });

      setRefresh((value) => value + 1);
    } catch (reason) {
      const message = fileRequestError(reason);
      if (
        message.includes("Git index changed since this review") ||
        message.includes("Git file selection changed") ||
        message.includes("File changed since its preview") ||
        message.includes("File changed since it was opened")
      )
        setReviewStale(true);
      setError(message);
    } finally {
      setBusyAction("");
    }
  };

  const commit = async () => {
    if (
      !status?.isRepo ||
      busy ||
      !commitMessage.trim() ||
      !stagedCount ||
      dirtyRef.current ||
      reviewStale
    )
      return;
    setBusyAction("commit");
    setError("");
    setNotice("");
    try {
      const result = await api<GitCommitResult>("/git/commit", {
        cwd: activeCwd,
        message: commitMessage,
        expectedIndexVersion: status.indexVersion,
      });
      setCommitMessage("");

      setNotice(
        `Committed ${result.commit.slice(0, 7)}${result.branch ? ` on ${result.branch}` : ""}`,
      );
      setRefresh((value) => value + 1);
    } catch (reason) {
      const message = fileRequestError(reason);
      if (message.includes("Git index changed since this review"))
        setReviewStale(true);
      setError(message);
    } finally {
      setBusyAction("");
    }
  };

  const changedFiles = status?.isRepo ? status.files : [];
  const selectedChange = changedFiles.find(
    (item) => item.path === selectedPath,
  );

  return (
    <section
      className="git-view"
      data-unsaved-file-edit={unsavedPaths.size > 0 || undefined}
      onKeyDown={(event) => {
        if (
          !event.defaultPrevented &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void save();
        }
      }}
    >
      {deleting && (
        <Modal title={deleting.directory ? 'Delete folder' : 'Delete file'} onClose={() => setDeleting(undefined)} dismissible={!busy}>
          <form onSubmit={(event) => { event.preventDefault(); void deleteEntry(); }}>
            <p>Move <strong style={{ overflowWrap: 'anywhere' }}>{deleting.path}</strong>{deleting.directory ? ' and its contents' : ''} to the trash?</p>
            {[...unsavedPaths].some((path) => path === deleting.path || (deleting.directory && path.startsWith(`${deleting.path}/`))) && (
              <p>Unsaved edits in this {deleting.directory ? 'folder' : 'file'} will be discarded.</p>
            )}
            <ErrorNotice error={deleteError} />
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</button>
              <button className="primary" type="submit" disabled={busy || saving}>{busyAction === 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
          </form>
        </Modal>
      )}
      <ErrorNotice error={error} />
      {reviewStale && (
        <p className="git-stale" role="alert">
          The reviewed Git state changed. Refresh and review the current changes
          before continuing.
        </p>
      )}
      <ResizableSplit
        className="git-content"
        initialSize={250}
        minSize={130}
        minRemaining={180}
        stackAt={420}
        label="Resize file tree"
        first={
          <nav className="git-files" aria-label="Files">
            <div className="file-filters">
              {status?.isRepo && (
                <>
                  <button
                    aria-pressed={!changesOnly}
                    onClick={() => {
                      setChangesOnly(false);
                      setShowDiff(false);
                    }}
                  >
                    All files
                  </button>
                  <button
                    aria-pressed={changesOnly}
                    onClick={() => {
                      setChangesOnly(true);
                      setShowDiff(true);
                    }}
                  >
                    Changes ({changedFiles.length})
                  </button>
                </>
              )}
              <IconButton
                label="Refresh files"
                disabled={loading || busy || saving}
                onClick={refreshStatus}
                title={
                  reviewStale
                    ? "Refresh before making another Git change"
                    : "Refresh files and Git status"
                }
              >
                <RefreshCw size={14} />
              </IconButton>
            </div>
            <FileTree
              key={activeCwd}
              cwd={activeCwd}
              refresh={refresh}
              changesOnly={changesOnly}
              changes={changedFiles}
              selectedPath={selectedPath}
              stagingDisabled={
                loading ||
                busy ||
                saving ||
                dirtyRef.current ||
                reviewStale
              }
              actionsDisabled={loading || busy || saving}
              onAction={(entry, action) => void entryAction(entry, action)}
              unsavedPaths={unsavedPaths}
              onSelect={selectFile}
              onStage={(path, staged) =>
                void mutateSelection(staged ? "stage" : "unstage", [path])
              }
              onError={(reason) => setError(fileRequestError(reason))}
            />
          </nav>
        }
        second={
          <section className="git-file-view" aria-label="Selected file">
            {file ? (
              <>
                <header className="git-file-header">
                  <span className="git-file-path" title={file.path}>
                    {file.path}
                  </span>
                  {dirty && (
                    <span
                      className="file-unsaved-dot"
                      aria-label="Unsaved changes"
                    />
                  )}
                  {saving && <span className="git-saving">Saving…</span>}
                  {selectedChange && (
                    <button
                      aria-pressed={showDiff}
                      onClick={() => setShowDiff(!showDiff)}
                    >
                      {showDiff ? "Code" : "Diff"}
                    </button>
                  )}
                </header>
                {conflict && (
                  <div className="git-conflict" role="alert">
                    <span>
                      This file changed on disk. Your draft is preserved; reload
                      only after copying it.
                    </span>
                    <button type="button" onClick={discardAndReload}>
                      <RotateCcw size={14} /> Discard draft &amp; reload
                    </button>
                  </div>
                )}
                {showDiff && selectedChange ? (
                  <div className="git-diffs">
                    <DiffSection diff={file.diff} path={file.path} />
                  </div>
                ) : file.content !== null ? (
                  <CodeEditor
                    key={`${activeCwd}/${file.path}`}
                    path={file.path}
                    value={normalizeLines(draft)}
                    editable={file.editable && !branchBusy}
                    wrap={wrap}
                    onChange={changeDraft}
                    onSave={(value) => void save(value)}
                    onError={(reason) => setError(fileRequestError(reason))}
                  />
                ) : null}
                {!file.editable && (
                  <p className="git-readonly">
                    This file is read-only. Only small, uniform UTF-8 text files
                    can be edited here.
                  </p>
                )}
              </>
            ) : (
              <p className="git-empty">
                {selectedPath
                  ? loadingFile
                    ? `Loading ${selectedPath}…`
                    : "Could not load this file."
                  : "Select a file."}
              </p>
            )}
          </section>
        }
      />
      {status?.isRepo && (stagedCount > 0 || Boolean(commitMessage)) && (
        <div className="git-commit-bar">
          <input
            aria-label="Commit message"
            placeholder={
              stagedCount ? "Commit message" : "Stage changes before committing"
            }
            value={commitMessage}
            maxLength={10_000}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <button
            type="button"
            className="primary"
            disabled={
              !stagedCount ||
              !commitMessage.trim() ||
              busy ||
              dirtyRef.current ||
              reviewStale ||
              loading
            }
            onClick={() => void commit()}
          >
            <GitCommitHorizontal size={15} />{" "}
            {busyAction === "commit" ? "Committing…" : "Commit"}
          </button>
        </div>
      )}
      {notice && (
        <footer className="git-footer" role="status">
          {notice}
        </footer>
      )}
    </section>
  );
}

function DiffSection({ diff, path }: { diff: string; path: string }) {
  return (
    <section className="git-diff-section">
      {diff ? (
        <pre className="git-diff" aria-label={`Changes diff for ${path}`}>
          {diff.split("\n").map((line, index) => (
            <span
              key={index}
              className={
                line.startsWith("+") && !line.startsWith("+++")
                  ? "git-diff-add"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "git-diff-del"
                    : line.startsWith("@@")
                      ? "git-diff-hunk"
                      : undefined
              }
            >
              {line || " "}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <p className="git-empty-diff">No textual changes.</p>
      )}
    </section>
  );
}

function isModified(draft?: FileDraft) {
  return Boolean(
    draft &&
    draft.file.editable &&
    normalizeLines(draft.text) !== normalizeLines(draft.file.content ?? ""),
  );
}

function hasIndexChange(file: GitChangedFile) {
  return !file.untracked && file.indexStatus !== " ";
}

function fileRequestError(reason: unknown) {
  const message = (reason as Error).message;
  return message === "Not found"
    ? "Server update required. Finish active Web sessions, then run pi-webui restart."
    : message;
}

function normalizeLines(text: string) {
  return text.replace(/\r\n?/g, "\n");
}
