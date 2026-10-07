import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Trash2 } from "lucide-react";
import type { FileDirectory, FileEntry, GitChangedFile } from "../shared/git";
import { api } from "./api";
import { FileIcon } from "./FileIcon";
import { ContextMenu } from './ContextMenu';

type TreeProps = {
  cwd: string;
  refresh: number;
  changesOnly: boolean;
  changes: GitChangedFile[];
  selectedPath: string;
  stagingDisabled: boolean;
  actionsDisabled: boolean;
  onAction: (entry: FileEntry, action: 'reveal' | 'delete') => void;
  unsavedPaths: Set<string>;
  onSelect: (path: string) => void;
  onStage: (path: string, staged: boolean) => void;
  onError: (error: unknown) => void;
};
type Cache = Map<string, { refresh: number; entries: FileEntry[] }>;

export function FileTree(props: TreeProps) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const cache = useRef<Cache>(new Map());
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number }>();
  useEffect(() => { setMenu(undefined); }, [props.refresh]);
  const openMenu = (target: HTMLElement, x: number, y: number) => {
    const path = target.dataset.path!;
    target.focus();
    setMenu({ entry: { path, name: path.split('/').at(-1)!, directory: target.hasAttribute('aria-expanded') }, x, y });
  };
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  useEffect(() => {
    if (props.changesOnly)
      setExpanded(
        (current) =>
          new Set([
            ...current,
            ...props.changes.flatMap((file) =>
              file.path
                .split("/")
                .slice(0, -1)
                .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
            ),
          ]),
      );
  }, [props.changesOnly]);
  const missing = Boolean(menu && !menu.entry.directory && props.changes.some((file) =>
    file.path === menu.entry.path && (file.worktreeStatus === 'D' || (file.indexStatus === 'D' && file.worktreeStatus === ' ')),
  ));

  return (
    <>
    <div
      role="tree"
      aria-label="File tree"
      onContextMenu={(event) => {
        const element = event.target as HTMLElement;
        const target = element.closest<HTMLElement>('[role="treeitem"]') ||
          element.closest('.git-file-row')?.querySelector<HTMLElement>('[role="treeitem"]');
        if (!target) return;
        event.preventDefault();
        const bounds = target.getBoundingClientRect();
        openMenu(target, event.clientX || bounds.left, event.clientY || bounds.bottom);
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.getAttribute("role") !== "treeitem") return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const bounds = target.getBoundingClientRect();
          openMenu(target, bounds.left, bounds.bottom);
          return;
        }
        const nodes = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            '[role="treeitem"]',
          ),
        ];
        const index = nodes.indexOf(target);
        const path = target.dataset.path!;
        let next: HTMLElement | undefined;
        if (event.key === "ArrowDown") next = nodes[index + 1];
        else if (event.key === "ArrowUp") next = nodes[index - 1];
        else if (event.key === "Home") next = nodes[0];
        else if (event.key === "End") next = nodes.at(-1);
        else if (
          event.key === "ArrowRight" &&
          target.hasAttribute("aria-expanded")
        ) {
          if (!expanded.has(path)) toggle(path);
          else next = nodes[index + 1];
        } else if (event.key === "ArrowLeft") {
          if (expanded.has(path)) toggle(path);
          else
            next = nodes.find(
              (node) =>
                node.dataset.path === path.split("/").slice(0, -1).join("/"),
            );
        } else return;
        event.preventDefault();
        next?.focus();
      }}
    >
      <Directory
        {...props}
        path=""
        depth={0}
        expanded={expanded}
        toggle={toggle}
        cache={cache.current}
      />
    </div>
    {menu && (
      <ContextMenu key={menu.entry.path} x={menu.x} y={menu.y} label="File actions" onClose={() => setMenu(undefined)}>
        <button role="menuitem" disabled={props.actionsDisabled || missing} title={missing ? 'Already deleted' : undefined} onClick={() => {
          props.onAction(menu.entry, 'reveal');
          setMenu(undefined);
        }}><FolderOpen size={15} /> Reveal in file manager</button>
        <button role="menuitem" disabled={props.actionsDisabled || missing} title={missing ? 'Already deleted' : undefined} onClick={() => {
          props.onAction(menu.entry, 'delete');
          setMenu(undefined);
        }}><Trash2 size={15} /> Delete</button>
      </ContextMenu>
    )}
    </>
  );
}

function Directory(
  props: TreeProps & {
    path: string;
    entry?: FileEntry;
    depth: number;
    expanded: Set<string>;
    toggle: (path: string) => void;
    cache: Cache;
  },
) {
  const {
    cwd,
    path,
    entry,
    depth,
    refresh,
    changesOnly,
    changes,
    expanded,
    toggle,
    cache,
  } = props;
  const open = !entry || expanded.has(path);
  const [entries, setEntries] = useState<FileEntry[] | undefined>(() => cache.get(path)?.entries);
  const [error, setError] = useState(false);
  const onError = useRef(props.onError);
  onError.current = props.onError;
  useEffect(() => {
    if (!open || changesOnly) return;
    const cached = cache.get(path);
    if (cached?.refresh === refresh) {
      setEntries(cached.entries);
      return;
    }
    let active = true;
    setError(false);
    void api<FileDirectory>(`/files?${new URLSearchParams({ cwd, path })}`)
      .then((listing) => {
        if (!active) return;
        cache.set(path, { refresh, entries: listing.entries });
        setEntries(listing.entries);
      })
      .catch((reason) => {
        if (!active) return;
        setError(true);
        onError.current(reason);
      });
    return () => {
      active = false;
    };
  }, [cwd, path, open, refresh, changesOnly]);

  const visible = changesOnly ? changedEntries(changes, path) : entries;
  return (
    <>
      {entry && (
        <button
          className="git-file-select file-folder"
          role="treeitem"
          aria-expanded={open}
          data-path={path}
          title={path}
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={() => toggle(path)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span
            className="git-file-name"
            data-git-kind={changeKind(changes, path, true)}
          >
            {entry.name}
          </span>
        </button>
      )}
      {open && (
        <div role={entry ? "group" : undefined}>
          {visible ? (
            visible.map((item) =>
              item.directory ? (
                <Directory
                  {...props}
                  key={item.path}
                  path={item.path}
                  entry={item}
                  depth={entry ? depth + 1 : depth}
                />
              ) : (
                <div
                  className={`git-file-row${item.path === props.selectedPath ? " selected" : ""}`}
                  key={item.path}
                  style={{ paddingLeft: (entry ? depth + 1 : depth) * 14 + 4 }}
                >
                  {changes
                    .filter((change) => change.path === item.path)
                    .map((change) => (
                      <StagingCheckbox
                        key={change.path}
                        change={change}
                        disabled={props.stagingDisabled}
                        onChange={(staged) => props.onStage(item.path, staged)}
                      />
                    ))}
                  <button
                    className="git-file-select"
                    role="treeitem"
                    aria-selected={item.path === props.selectedPath}
                    data-path={item.path}
                    title={item.path}
                    onClick={() => props.onSelect(item.path)}
                  >
                    <FileIcon name={item.name} />
                    <span
                      className="git-file-name"
                      data-git-kind={changeKind(changes, item.path)}
                    >
                      {item.name}
                    </span>
                    {props.unsavedPaths.has(item.path) && (
                      <span
                        className="file-unsaved-dot"
                        aria-label={`Unsaved ${item.path}`}
                      />
                    )}
                    {changes
                      .filter((change) => change.path === item.path)
                      .map((change) => (
                        <span
                          className="git-file-status"
                          key={change.path}
                          title={
                            change.untracked
                              ? "Untracked"
                              : `Index: ${change.indexStatus}; worktree: ${change.worktreeStatus}`
                          }
                        >
                          {change.untracked
                            ? "??"
                            : `${change.indexStatus}${change.worktreeStatus}`}
                        </span>
                      ))}
                  </button>
                </div>
              ),
            )
          ) : (
            <p className="git-empty">
              {error ? "Could not load this folder." : "Loading files…"}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function StagingCheckbox({
  change,
  disabled,
  onChange,
}: {
  change: GitChangedFile;
  disabled: boolean;
  onChange: (staged: boolean) => void;
}) {
  const staged = !change.untracked && change.indexStatus !== " ";
  const mixed = staged && change.worktreeStatus !== " ";
  return (
    <input
      type="checkbox"
      aria-label={`Stage ${change.path}`}
      aria-checked={mixed ? "mixed" : staged}
      title={
        mixed
          ? "Partially staged · stage the remaining changes"
          : staged
            ? "Staged · unstage this file"
            : "Unstaged · stage this file"
      }
      checked={staged && !mixed}
      disabled={disabled}
      ref={(input) => {
        if (input) input.indeterminate = mixed;
      }}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function changeKind(
  changes: GitChangedFile[],
  path: string,
  directory = false,
) {
  const kinds = new Set(
    changes
      .filter((change) =>
        directory
          ? change.path.startsWith(`${path}/`) ||
            change.originalPath?.startsWith(`${path}/`)
          : change.path === path,
      )
      .map((change) => {
        const status = change.indexStatus + change.worktreeStatus;
        if (status.includes("U") || status === "AA" || status === "DD")
          return "conflict";
        if (status.includes("D")) return "deleted";
        if (
          status.includes("M") ||
          status.includes("R") ||
          status.includes("C") ||
          status.includes("T")
        )
          return "modified";
        return "added";
      }),
  );
  return kinds.has("conflict")
    ? "conflict"
    : kinds.size > 1
      ? "modified"
      : [...kinds][0];
}

function changedEntries(changes: GitChangedFile[], path: string) {
  const prefix = path ? `${path}/` : "";
  const entries = new Map<string, FileEntry>();
  for (const file of changes) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const name = rest.split("/")[0]!;
    entries.set(name, {
      name,
      path: `${prefix}${name}`,
      directory: rest.includes("/"),
    });
  }
  return [...entries.values()].sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
}
