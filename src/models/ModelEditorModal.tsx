import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  DEFAULT_REASONING_LEVELS,
  levelsToThinkingLevelMap,
  THINKING_LEVELS,
  thinkingLevelMapToLevels,
  type DiscoveredModel,
  type ManagedModel,
  type ManagedProvider,
  type ModelInputType,
  type ModelsCatalogResponse,
  type ModelUpsertInput,
  type ThinkingLevelMap,
  type ThinkingLevelOption,
} from "../../shared/models";
import { api } from "../lib/api";
import { ErrorNotice, Modal } from "../components/ui";

function extractWireValues(
  map?: ThinkingLevelMap,
): Partial<Record<ThinkingLevelOption, string>> {
  const out: Partial<Record<ThinkingLevelOption, string>> = {};
  if (!map) return out;
  for (const level of THINKING_LEVELS) {
    const val = map[level];
    if (typeof val === "string" && val.trim() && val !== level) {
      out[level] = val;
    }
  }
  return out;
}

export function ModelEditorModal({
  provider,
  model,
  knownApis,
  onClose,
  onSaved,
}: {
  provider: ManagedProvider;
  model?: ManagedModel;
  knownApis: readonly string[];
  onClose: () => void;
  onSaved: (catalog: ModelsCatalogResponse) => void;
}) {
  const isNew = !model;
  const [id, setId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [apiType, setApiType] = useState(
    model?.source === "custom" ? (model.rawApi ?? "") : "",
  );
  const [baseUrl, setBaseUrl] = useState(
    model?.source === "custom" && model.baseUrl !== provider.baseUrl
      ? model.baseUrl ?? ""
      : "",
  );
  const [contextWindow, setContextWindow] = useState(
    String(model?.contextWindow ?? 128000),
  );
  const [maxTokens, setMaxTokens] = useState(
    String(model?.maxTokens ?? 16384),
  );
  const [supportsImage, setSupportsImage] = useState(
    model?.input.includes("image") ?? false,
  );

  const [reasoning, setReasoning] = useState(model?.reasoning ?? false);
  const [enabledLevels, setEnabledLevels] = useState<ThinkingLevelOption[]>(() =>
    model?.reasoning
      ? thinkingLevelMapToLevels(true, model.thinkingLevelMap)
      : [...DEFAULT_REASONING_LEVELS],
  );
  const [wireValues, setWireValues] = useState<
    Partial<Record<ThinkingLevelOption, string>>
  >(() => extractWireValues(model?.thinkingLevelMap));
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState(
    model?.defaultThinkingLevel ?? "",
  );

  const [costInput, setCostInput] = useState(String(model?.cost?.input ?? 0));
  const [costOutput, setCostOutput] = useState(String(model?.cost?.output ?? 0));
  const [costCacheRead, setCostCacheRead] = useState(
    String(model?.cost?.cacheRead ?? 0),
  );
  const [costCacheWrite, setCostCacheWrite] = useState(
    String(model?.cost?.cacheWrite ?? 0),
  );

  const [inferring, setInferring] = useState(false);
  const [inferNote, setInferNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const activeLevels = reasoning ? enabledLevels : (["off"] as ThinkingLevelOption[]);

  const toggleLevel = (level: ThinkingLevelOption) => {
    setEnabledLevels((prev) => {
      if (prev.includes(level)) {
        if (prev.length === 1) return prev;
        return prev.filter((item) => item !== level);
      }
      return THINKING_LEVELS.filter(
        (item) => item === level || prev.includes(item),
      );
    });
  };

  const autoDetect = async () => {
    if (!id.trim() || inferring) return;
    setInferring(true);
    setError("");
    setInferNote("");
    try {
      const detected = await api<DiscoveredModel>("/models/infer", {
        providerId: provider.id,
        modelId: id.trim(),
        baseUrl: baseUrl.trim() || undefined,
        api: apiType || undefined,
      });
      if (!name.trim() || name === id) setName(detected.name);
      setReasoning(detected.reasoning);
      setEnabledLevels(
        detected.reasoning
          ? thinkingLevelMapToLevels(true, detected.thinkingLevelMap)
          : [...DEFAULT_REASONING_LEVELS],
      );
      setWireValues(extractWireValues(detected.thinkingLevelMap));
      setContextWindow(String(detected.contextWindow));
      setMaxTokens(String(detected.maxTokens));
      setSupportsImage(detected.input.includes("image"));
      if (detected.cost) {
        setCostInput(String(detected.cost.input));
        setCostOutput(String(detected.cost.output));
        setCostCacheRead(String(detected.cost.cacheRead));
        setCostCacheWrite(String(detected.cost.cacheWrite));
      }
      setInferNote(
        detected.reasoningSource === "provider-api"
          ? "Detected from provider API"
          : detected.reasoningSource === "catalog"
            ? "Detected from model catalog"
            : detected.reasoningSource === "heuristic"
              ? "Detected from model family"
              : "No catalog match — default settings applied",
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setInferring(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError("");

    const parsedContext = Number(contextWindow);
    const parsedMaxTokens = Number(maxTokens);
    if (!Number.isFinite(parsedContext) || parsedContext <= 0) {
      setError("Context window must be a positive number");
      return;
    }
    if (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens <= 0) {
      setError("Max output tokens must be a positive number");
      return;
    }

    const effectiveDefault =
      defaultThinkingLevel &&
      activeLevels.includes(defaultThinkingLevel as ThinkingLevelOption)
        ? defaultThinkingLevel
        : "";

    setBusy(true);
    try {
      const inputModalities: ModelInputType[] = supportsImage
        ? ["text", "image"]
        : ["text"];
      const payload: ModelUpsertInput = {
        providerId: provider.id,
        originalId: model?.id,
        id: id.trim(),
        name: name.trim(),
        api: apiType.trim(),
        baseUrl: baseUrl.trim(),
        reasoning,
        thinkingLevelMap: reasoning
          ? levelsToThinkingLevelMap(enabledLevels, wireValues)
          : undefined,
        defaultThinkingLevel: effectiveDefault,
        input: inputModalities,
        contextWindow: parsedContext,
        maxTokens: parsedMaxTokens,
        cost: {
          input: Number(costInput) || 0,
          output: Number(costOutput) || 0,
          cacheRead: Number(costCacheRead) || 0,
          cacheWrite: Number(costCacheWrite) || 0,
        },
      };
      const catalog = await api<ModelsCatalogResponse>("/models/model", payload);
      onSaved(catalog);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        isNew
          ? `Add model · ${provider.name}`
          : model.source === "builtin"
            ? `Override built-in model · ${model.id}`
            : `Edit model · ${model.id}`
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      className="models-modal"
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="models-id-row">
          <label>
            Model ID
            <input
              autoFocus={isNew}
              required
              disabled={model?.source === "builtin" || model?.source === "overridden"}
              placeholder="gpt-5.4 or qwen3:32b"
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="models-detect-btn"
            disabled={!id.trim() || inferring}
            onClick={() => void autoDetect()}
            title="Detect model specs and reasoning levels from Pi catalog or model ID"
          >
            <Sparkles size={14} />
            {inferring ? "Detecting…" : "Auto-detect"}
          </button>
        </div>
        {inferNote && <p className="models-infer-note">{inferNote}</p>}

        <label>
          Display name
          <input
            placeholder="Optional friendly name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {model?.source !== "builtin" && model?.source !== "overridden" && (
          <div className="models-form-grid">
            <label>
              API protocol override
              <select
                value={apiType}
                onChange={(event) => setApiType(event.target.value)}
              >
                <option value="">
                  Inherit ({provider.rawApi || provider.api || "provider default"})
                </option>
                {knownApis.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
                {apiType && !knownApis.includes(apiType) && (
                  <option value={apiType}>{apiType}</option>
                )}
              </select>
            </label>
            <label>
              Base URL override
              <input
                placeholder={provider.baseUrl || "Inherit from provider"}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
          </div>
        )}

        <div className="models-form-grid">
          <label>
            Context window (tokens)
            <input
              type="number"
              min={1}
              required
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
            />
          </label>
          <label>
            Max output tokens
            <input
              type="number"
              min={1}
              required
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </label>
        </div>

        <label className="models-checkbox-row">
          <input
            type="checkbox"
            checked={supportsImage}
            onChange={(event) => setSupportsImage(event.target.checked)}
          />
          <span>Supports image input (vision)</span>
        </label>

        <fieldset className="models-fieldset">
          <legend>Reasoning &amp; Thinking Levels</legend>

          <label className="models-checkbox-row">
            <input
              type="checkbox"
              checked={reasoning}
              onChange={(event) => setReasoning(event.target.checked)}
            />
            <span>Supports reasoning / thinking</span>
          </label>

          {reasoning && (
            <>
              <div className="models-field-label">
                Supported reasoning levels (click to toggle)
              </div>
              <div className="models-pill-wrap">
                {THINKING_LEVELS.map((level) => {
                  const active = enabledLevels.includes(level);
                  return (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={active}
                      className={active ? "selected-pill" : "subtle-pill"}
                      onClick={() => toggleLevel(level)}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>

              <div className="models-quick-links">
                <button
                  type="button"
                  className="automation-link"
                  onClick={() => setEnabledLevels([...DEFAULT_REASONING_LEVELS])}
                >
                  Standard (off–high)
                </button>
                <button
                  type="button"
                  className="automation-link"
                  onClick={() => setEnabledLevels([...THINKING_LEVELS])}
                >
                  All (off–max)
                </button>
                <button
                  type="button"
                  className="automation-link"
                  onClick={() => setEnabledLevels(["low", "medium", "high"])}
                >
                  Always on (low–high)
                </button>
              </div>

              <details
                className="models-details models-subdetails"
                open={Object.keys(wireValues).length > 0}
              >
                <summary>Advanced: custom API level mapping</summary>
                <div className="models-level-grid">
                  {enabledLevels.map((level) => (
                    <div className="models-level-wire-row" key={level}>
                      <code>{level}</code>
                      <input
                        aria-label={`API wire value for ${level}`}
                        placeholder={level}
                        value={wireValues[level] ?? ""}
                        onChange={(event) => {
                          const val = event.target.value;
                          setWireValues((prev) => ({ ...prev, [level]: val }));
                        }}
                      />
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}

          <label className="models-inline-field">
            Default thinking level for this model
            <select
              value={
                activeLevels.includes(
                  defaultThinkingLevel as ThinkingLevelOption,
                )
                  ? defaultThinkingLevel
                  : ""
              }
              onChange={(event) => setDefaultThinkingLevel(event.target.value)}
            >
              <option value="">Auto (use global default)</option>
              {activeLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <details className="models-details">
          <summary>Pricing ($ per 1M tokens)</summary>
          <div className="models-form-grid">
            <label>
              Input
              <input
                type="number"
                step="any"
                min={0}
                value={costInput}
                onChange={(event) => setCostInput(event.target.value)}
              />
            </label>
            <label>
              Output
              <input
                type="number"
                step="any"
                min={0}
                value={costOutput}
                onChange={(event) => setCostOutput(event.target.value)}
              />
            </label>
            <label>
              Cache read
              <input
                type="number"
                step="any"
                min={0}
                value={costCacheRead}
                onChange={(event) => setCostCacheRead(event.target.value)}
              />
            </label>
            <label>
              Cache write
              <input
                type="number"
                step="any"
                min={0}
                value={costCacheWrite}
                onChange={(event) => setCostCacheWrite(event.target.value)}
              />
            </label>
          </div>
        </details>

        <ErrorNotice error={error} />

        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !id.trim()}
          >
            {busy ? "Saving…" : "Save model"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
