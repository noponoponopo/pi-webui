import { useState } from "react";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { basename } from "./api";
import type { SessionPreset } from "./presets";
import { WorkspacePathInput } from "./WorkspacePathInput";
import { IconButton, Modal } from "./ui";

export function PresetsModal({
  presets,
  defaultCwd,
  onChange,
  onLaunch,
  onClose,
}: {
  presets: SessionPreset[];
  defaultCwd: string;
  onChange: (next: SessionPreset[]) => void;
  onLaunch: (preset: SessionPreset) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<SessionPreset | "new">();
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [promptPrefix, setPromptPrefix] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");

  const startEdit = (preset?: SessionPreset) => {
    setEditing(preset ?? "new");
    setName(preset?.name || "");
    setCwd(preset?.cwd || defaultCwd);
    setPromptPrefix(preset?.promptPrefix || "");
    setThinkingLevel(preset?.thinkingLevel || "");
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const item: SessionPreset = {
      id: editing && editing !== "new" ? editing.id : crypto.randomUUID(),
      name: name.trim(),
      cwd: cwd.trim() || undefined,
      promptPrefix: promptPrefix.trim() || undefined,
      thinkingLevel: thinkingLevel || undefined,
    };
    const next =
      editing && editing !== "new"
        ? presets.map((p) => (p.id === item.id ? item : p))
        : [item, ...presets];
    onChange(next);
    setEditing(undefined);
  };

  return (
    <Modal title={editing ? (editing === "new" ? "New preset" : "Edit preset") : "Presets"} onClose={onClose}>
      {editing ? (
        <form onSubmit={save}>
          <label>
            Preset name
            <input
              autoFocus
              required
              maxLength={80}
              placeholder="Code reviewer"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Default workspace (optional)
            <WorkspacePathInput value={cwd} onChange={setCwd} />
          </label>
          <label>
            Thinking level (optional)
            <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
              <option value="">Default</option>
              <option value="off">off</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
          <label>
            Initial prompt / instructions (optional)
            <textarea
              rows={4}
              placeholder="Prefilled into the composer when launching this preset…"
              value={promptPrefix}
              onChange={(event) => setPromptPrefix(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={() => setEditing(undefined)}>
              Back
            </button>
            <button type="submit" className="primary" disabled={!name.trim()}>
              Save preset
            </button>
          </div>
        </form>
      ) : (
        <div className="presets-manager">
          <div className="presets-list">
            {presets.map((preset) => (
              <div className="preset-row" key={preset.id}>
                <div className="preset-info">
                  <strong>{preset.name}</strong>
                  <small>
                    {[
                      preset.cwd ? basename(preset.cwd) : null,
                      preset.thinkingLevel ? `thinking: ${preset.thinkingLevel}` : null,
                      preset.promptPrefix ? preset.promptPrefix.slice(0, 48) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No defaults set"}
                  </small>
                </div>
                <div className="preset-actions">
                  <button className="subtle-pill" onClick={() => onLaunch(preset)} title="Start session with preset">
                    <Play size={13} /> Start
                  </button>
                  <IconButton label="Edit preset" onClick={() => startEdit(preset)}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton
                    label="Delete preset"
                    onClick={() => onChange(presets.filter((item) => item.id !== preset.id))}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
            {presets.length === 0 && (
              <p className="empty-note">
                Save reusable workspace, thinking level, and prompt templates as presets.
              </p>
            )}
          </div>
          <div className="dialog-actions">
            <button className="primary" onClick={() => startEdit()}>
              <Plus size={15} />
              New preset
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
