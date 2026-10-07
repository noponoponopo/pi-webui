import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import type { GitStatus } from "../shared/git";
import { api } from "./api";
import { ErrorNotice } from "./ui";

export function GitBranchMenu({
  status,
  disabled,
  onChange,
  onBusyChange,
  onRefresh,
}: {
  status: GitStatus & { isRepo: true };
  disabled: boolean;
  onChange: (status: GitStatus) => void;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const restoreFocus = useRef(false);
  const close = () => {
    restoreFocus.current = true;
    setOpen(false);
  };
  useEffect(() => {
    if (!open && !busy && restoreFocus.current) {
      ref.current
        ?.querySelector<HTMLButtonElement>(".git-branch-button")
        ?.focus();
      restoreFocus.current = false;
    }
  }, [open, busy]);
  useEffect(() => {
    if (!open) return;
    ref.current
      ?.querySelector<HTMLInputElement>(".git-branch-search")
      ?.focus();
    const dismiss = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  const change = async (branch: string, create = false) => {
    if (disabled || busy || (!create && branch === status.branch)) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const next = await api<GitStatus>(
        create ? "/git/create-branch" : "/git/switch",
        {
          cwd: status.root,
          branch,
          expectedIndexVersion: status.indexVersion,
        },
      );
      onChange(next);
      setName("");
      close();
    } catch (reason) {
      setError((reason as Error).message);
      onRefresh();
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };

  const queryLower = query.trim().toLowerCase();
  const filtered = status.branches.filter((branch) =>
    branch.toLowerCase().includes(queryLower),
  );

  return (
    <div ref={ref} className="git-branch-menu"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}>
      <button type="button" className="git-branch-button"
        aria-label="Select Git branch" aria-expanded={open} aria-controls={id}
        title={`Repository: ${status.root}`} disabled={busy}
        onClick={(event) => {
          if (!open) {
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition({
              left: Math.max(12, Math.min(rect.right - 280, innerWidth - 292)),
              top: rect.bottom + 5,
            });
            setQuery("");
            setError("");
            onRefresh();
          }
          setOpen(!open);
        }}>
        <GitBranch size={14} />
        <span>{status.branch || "Detached HEAD"}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu git-branch-options" id={id} style={position}>
          <input
            aria-label="Search branches"
            className="git-branch-search"
            placeholder="Search branches"
            value={query}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled || busy}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="git-branch-list" role="listbox" aria-label="Branches">
            {filtered.map((branch) => (
              <button
                key={branch}
                type="button"
                role="option"
                aria-selected={branch === status.branch}
                title={branch}
                disabled={
                  disabled ||
                  busy ||
                  status.worktrees.some(
                    (item) => item.path !== status.root && item.branch === branch,
                  )
                }
                onClick={() => void change(branch)}
              >
                {branch === status.branch && <Check size={13} />}
                <span>{branch}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="git-branch-empty">No matching branches</p>
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void change(name.trim(), true);
            }}
          >
            <input
              aria-label="New branch name"
              placeholder="New branch name"
              value={name}
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled || busy}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" disabled={disabled || busy || !name.trim()}>
              {busy ? "Switching…" : "Create branch"}
            </button>
          </form>
          {disabled && (
            <p className="git-branch-hint">
              Save your edits and wait for file operations to finish before
              changing branches.
            </p>
          )}
          <ErrorNotice error={error} />
        </div>
      )}
    </div>
  );
}
