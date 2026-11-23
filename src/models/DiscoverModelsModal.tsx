import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import {
  DEFAULT_REASONING_LEVELS,
  levelsToThinkingLevelMap,
  THINKING_LEVELS,
  thinkingLevelMapToLevels,
  type DiscoveredModel,
  type DiscoverModelsResponse,
  type ManagedProvider,
  type ModelsCatalogResponse,
  type ModelUpsertInput,
  type ThinkingLevelOption,
} from "../../shared/models";
import { api } from "../lib/api";
import { ErrorNotice, Modal } from "../components/ui";

export function DiscoverModelsModal({
  provider,
  knownApis,
  onClose,
  onImported,
}: {
  provider: ManagedProvider;
  knownApis: readonly string[];
  onClose: () => void;
  onImported: (catalog: ModelsCatalogResponse) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiType, setApiType] = useState(provider.api ?? "openai-completions");
  const [apiKeyOverride, setApiKeyOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const discover = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await api<DiscoverModelsResponse>("/models/discover", {
        providerId: provider.id,
        baseUrl: baseUrl.trim() || undefined,
        api: apiType.trim() || undefined,
        apiKey: apiKeyOverride.trim() || undefined,
      });
      setEndpoint(response.endpoint);
      setModels(response.models);
      const initial = new Set<string>();
      for (const item of response.models) {
        if (!item.alreadyConfigured) initial.add(item.id);
      }
      setSelected(initial);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (provider.baseUrl) void discover();
  }, [provider.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((item) =>
      `${item.id} ${item.name}`.toLowerCase().includes(q),
    );
  }, [models, query]);

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleReasoning = (id: string, enabled: boolean) => {
    setModels((list) =>
      list.map((item) => {
        if (item.id !== id) return item;
        const levels = enabled
          ? item.supportedThinkingLevels.filter((l) => l !== "off").length > 0
            ? item.supportedThinkingLevels
            : [...DEFAULT_REASONING_LEVELS]
          : ["off" as ThinkingLevelOption];
        return {
          ...item,
          reasoning: enabled,
          thinkingLevelMap: enabled ? levelsToThinkingLevelMap(levels) : undefined,
          supportedThinkingLevels: levels,
        };
      }),
    );
  };

  const toggleModelLevel = (id: string, level: ThinkingLevelOption) => {
    setModels((list) =>
      list.map((item) => {
        if (item.id !== id) return item;
        const current = thinkingLevelMapToLevels(true, item.thinkingLevelMap);
        let next: ThinkingLevelOption[];
        if (current.includes(level)) {
          if (current.length === 1) return item;
          next = current.filter((l) => l !== level);
        } else {
          next = THINKING_LEVELS.filter(
            (l) => l === level || current.includes(l),
          );
        }
        return {
          ...item,
          reasoning: true,
          thinkingLevelMap: levelsToThinkingLevelMap(next),
          supportedThinkingLevels: next,
        };
      }),
    );
  };

  const importSelected = async () => {
    if (importing || selected.size === 0) return;
    setImporting(true);
    setError("");
    const customBaseUrl =
      baseUrl.trim() && baseUrl.trim() !== (provider.baseUrl ?? "")
        ? baseUrl.trim()
        : undefined;
    try {
      const payload: ModelUpsertInput[] = models
        .filter((item) => selected.has(item.id))
        .map((item) => ({
          providerId: provider.id,
          id: item.id,
          name: item.name,
          api: item.api || apiType || undefined,
          ...(customBaseUrl ? { baseUrl: customBaseUrl } : {}),
          reasoning: item.reasoning,
          thinkingLevelMap: item.reasoning ? item.thinkingLevelMap : undefined,
          input: item.input,
          contextWindow: item.contextWindow,
          maxTokens: item.maxTokens,
          cost: item.cost,
        }));
      const catalog = await api<ModelsCatalogResponse>("/models/model/import", {
        providerId: provider.id,
        models: payload,
      });
      onImported(catalog);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      title={`Discover models · ${provider.name}`}
      onClose={() => {
        if (!importing) onClose();
      }}
      className="models-modal models-discover-modal"
    >
      <div className="models-discover-controls">
        <div className="models-form-grid">
          <label>
            Base URL
            <input
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            API protocol
            <select
              value={apiType}
              onChange={(event) => setApiType(event.target.value)}
            >
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
        </div>
        <div className="models-id-row">
          <label>
            API key override (optional)
            <input
              type="password"
              autoComplete="off"
              placeholder={
                provider.auth.configured
                  ? "Using configured provider auth (same origin)"
                  : "Bearer token if needed"
              }
              value={apiKeyOverride}
              onChange={(event) => setApiKeyOverride(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="models-detect-btn"
            disabled={loading || !baseUrl.trim()}
            onClick={() => void discover()}
          >
            {loading ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {loading ? "Fetching…" : "Fetch models"}
          </button>
        </div>
      </div>

      <ErrorNotice error={error} />

      {models.length > 0 && (
        <>
          <div className="models-discover-toolbar">
            <label className="search-field models-discover-search">
              <Search size={15} />
              <input
                aria-label="Filter discovered models"
                placeholder={`Filter ${models.length} models…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="models-pill-wrap">
              <button
                type="button"
                className="subtle-pill"
                onClick={() =>
                  setSelected(new Set(filtered.map((item) => item.id)))
                }
              >
                Select shown
              </button>
              <button
                type="button"
                className="subtle-pill"
                onClick={() =>
                  setSelected(
                    new Set(
                      filtered
                        .filter((item) => !item.alreadyConfigured)
                        .map((item) => item.id),
                    ),
                  )
                }
              >
                New only
              </button>
              <button
                type="button"
                className="subtle-pill"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
          </div>
          {endpoint && (
            <p className="models-endpoint-note">
              Fetched {models.length} models from <code>{endpoint}</code>
            </p>
          )}
          <div className="models-discover-list">
            {filtered.map((item) => {
              const checked = selected.has(item.id);
              const activeLevels = item.reasoning
                ? thinkingLevelMapToLevels(true, item.thinkingLevelMap)
                : [];
              return (
                <div
                  key={item.id}
                  className={`models-discover-row ${checked ? "checked" : ""}`}
                >
                  <div className="models-discover-main">
                    <label className="models-discover-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleModel(item.id)}
                      />
                      <span className="models-discover-info">
                        <strong>{item.id}</strong>
                        <small>
                          {compactNumber(item.contextWindow)} ctx ·{" "}
                          {compactNumber(item.maxTokens)} out
                          {item.input.includes("image") ? " · vision" : ""}
                          {item.reasoningSource !== "default"
                            ? ` · ${item.reasoningSource}`
                            : ""}
                          {item.alreadyConfigured ? " · already configured" : ""}
                        </small>
                      </span>
                    </label>
                    <label className="models-discover-reasoning-toggle">
                      <input
                        type="checkbox"
                        checked={item.reasoning}
                        onChange={(event) =>
                          toggleReasoning(item.id, event.target.checked)
                        }
                      />
                      <span>Reasoning</span>
                    </label>
                  </div>
                  {item.reasoning && (
                    <div className="models-discover-levels">
                      {THINKING_LEVELS.map((level) => {
                        const active = activeLevels.includes(level);
                        return (
                          <button
                            key={level}
                            type="button"
                            aria-pressed={active}
                            className={`models-level-pill ${
                              active ? "selected-pill" : "subtle-pill"
                            }`}
                            onClick={() => toggleModelLevel(item.id, level)}
                          >
                            {level}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {!loading && models.length === 0 && !error && (
        <p className="empty-note">
          Enter the provider base URL and click Fetch models to auto-discover
          available models and reasoning capabilities.
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" disabled={importing} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={importing || selected.size === 0}
          onClick={() => void importSelected()}
        >
          {importing ? "Importing…" : `Import selected (${selected.size})`}
        </button>
      </div>
    </Modal>
  );
}

const compactNumber = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
