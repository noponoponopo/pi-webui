import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { FileDirectory } from "../shared/git";
import { api } from "./api";

export function WorkspacePathInput({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [listing, setListing] = useState<{ directory: string; names: string[] }>();
  const [suggest, setSuggest] = useState(true);
  const [selection, setSelection] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const slash = value.lastIndexOf("/");
  const directory = slash < 0 ? "" : value.slice(0, slash + 1);
  const prefix = value.slice(slash + 1);
  const choices = suggest && listing?.directory === directory
    ? listing.names.filter((name) => name.startsWith(prefix))
    : [];

  useEffect(() => {
    if (!directory || !suggest) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api<FileDirectory>(`/files?${new URLSearchParams({ cwd: directory })}`)
        .then((result) => {
          if (active) setListing({ directory, names: result.entries.filter((entry) => entry.directory).map((entry) => entry.name) });
        })
        .catch(() => { if (active) setListing(undefined); });
    }, 100);
    return () => { active = false; window.clearTimeout(timer); };
  }, [directory, suggest]);

  useEffect(() => {
    list.current?.children[selection]?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  const choose = (name: string) => {
    onChange(directory + name);
    setSuggest(false);
  };

  return (
    <div className="workspace-path-input">
      <input
        id="workspace-path"
        autoFocus
        aria-label="Working directory"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={choices.length > 0}
        aria-controls="workspace-path-options"
        aria-activedescendant={choices.length ? `workspace-path-option-${selection}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setSelection(0);
          setSuggest(true);
        }}
        onBlur={() => setSuggest(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !choices.length) return;
          if (event.key === "Enter") {
            event.preventDefault();
            choose(choices[selection]);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelection((selection + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setSuggest(false);
          }
        }}
        placeholder="/path/to/project"
        required
      />
      {choices.length > 0 && (
        <div ref={list} id="workspace-path-options" role="listbox" aria-label="Folders" className="workspace-path-options">
          {choices.map((name, index) => (
            <button
              key={name}
              id={`workspace-path-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === selection}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(name)}
            >
              <FolderOpen size={16} />{name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
