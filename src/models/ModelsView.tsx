import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Download,
  LoaderCircle,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import {
  THINKING_LEVELS,
  type ManagedModel,
  type ManagedProvider,
  type ModelsCatalogResponse,
} from "../../shared/models";
import { api } from "../lib/api";
import { ErrorNotice, IconButton } from "../components/ui";
import { formatAuthStatus, ProviderEditorModal } from "./ProviderEditorModal";
import { ModelEditorModal } from "./ModelEditorModal";
import { DiscoverModelsModal } from "./DiscoverModelsModal";

export function ModelsView({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  const [catalog, setCatalog] = useState<ModelsCatalogResponse>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"configured" | "custom" | "all">(
    "configured",
  );
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [editingProvider, setEditingProvider] = useState<
    ManagedProvider | "new"
  >();
  const [editingModel, setEditingModel] = useState<{
    provider: ManagedProvider;
    model?: ManagedModel;
  }>();
  const [discoveringProvider, setDiscoveringProvider] =
    useState<ManagedProvider>();

  const load = async () => {
    try {
      const next = await api<ModelsCatalogResponse>("/models");
      setCatalog(next);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      setCatalog(await api<ModelsCatalogResponse>("/models/refresh", {}));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const availableModels = useMemo(() => {
    if (!catalog) return [];
    const items: { provider: string; model: ManagedModel }[] = [];
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        if (model.available) items.push({ provider: provider.id, model });
      }
    }
    return items;
  }, [catalog]);

  const updateDefaults = async (
    defaultModelValue: string,
    defaultThinkingLevel: string,
  ) => {
    if (savingDefaults) return;
    setSavingDefaults(true);
    setError("");
    try {
      const slash = defaultModelValue.indexOf("/");
      const defaultProvider =
        slash > 0 ? defaultModelValue.slice(0, slash) : undefined;
      const defaultModel =
        slash > 0 ? defaultModelValue.slice(slash + 1) : undefined;
      setCatalog(
        await api<ModelsCatalogResponse>("/models/defaults", {
          defaultProvider,
          defaultModel,
          defaultThinkingLevel: defaultThinkingLevel || undefined,
        }),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSavingDefaults(false);
    }
  };

  const removeProvider = async (provider: ManagedProvider) => {
    const label = provider.isBuiltin
      ? `Reset overrides and stored credentials for “${provider.name}”?`
      : `Delete custom provider “${provider.name}” and its models?`;
    if (!window.confirm(label)) return;
    setError("");
    try {
      setCatalog(
        await api<ModelsCatalogResponse>("/models/provider/delete", {
          id: provider.id,
          removeStoredCredential: true,
        }),
      );
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const removeModel = async (provider: ManagedProvider, model: ManagedModel) => {
    const label =
      model.source === "overridden"
        ? `Reset overrides for built-in model “${model.id}”?`
        : `Delete model “${model.id}” from ${provider.name}?`;
    if (!window.confirm(label)) return;
    setError("");
    try {
      setCatalog(
        await api<ModelsCatalogResponse>("/models/model/delete", {
          providerId: provider.id,
          id: model.id,
        }),
      );
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const visibleProviders = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    return catalog.providers
      .filter((provider) => {
        if (filter === "configured") {
          return (
            !provider.isBuiltin ||
            provider.inModelsJson ||
            provider.auth.configured
          );
        }
        if (filter === "custom") {
          return !provider.isBuiltin || provider.inModelsJson;
        }
        return true;
      })
      .map((provider) => {
        if (!q) return { provider, models: provider.models };
        const providerMatches = `${provider.id} ${provider.name} ${provider.baseUrl ?? ""}`
          .toLowerCase()
          .includes(q);
        const matchingModels = provider.models.filter((model) =>
          `${model.id} ${model.name}`.toLowerCase().includes(q),
        );
        if (!providerMatches && matchingModels.length === 0) return undefined;
        return {
          provider,
          models: providerMatches ? provider.models : matchingModels,
        };
      })
      .filter((item): item is { provider: ManagedProvider; models: ManagedModel[] } =>
        Boolean(item),
      );
  }, [catalog, filter, query]);

  const currentDefaultModel =
    catalog?.defaults.provider && catalog?.defaults.model
      ? `${catalog.defaults.provider}/${catalog.defaults.model}`
      : "";

  return (
    <div className="session-view automations-view">
      <header className="session-header">
        <IconButton label="Toggle sidebar" onClick={onToggleSidebar}>
          <PanelLeft size={19} />
        </IconButton>
        <h1>Models &amp; Providers</h1>
        <div className="header-actions">
          <button
            type="button"
            className="subtle-pill"
            disabled={refreshing || loading}
            onClick={() => void refreshAll()}
            title="Sync built-in provider catalogs from pi.dev"
          >
            {refreshing ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Sync catalogs
          </button>
          <button
            className="primary compact-primary"
            onClick={() => setEditingProvider("new")}
          >
            <Plus size={15} />
            Add provider
          </button>
        </div>
      </header>

      <div className="automations-body">
        <ErrorNotice error={error || catalog?.configError || catalog?.warning} />

        {catalog && (
          <section className="models-defaults-card">
            <div className="models-defaults-grid">
              <label>
                Default model
                <select
                  aria-label="Default model"
                  disabled={savingDefaults}
                  value={currentDefaultModel}
                  onChange={(event) =>
                    void updateDefaults(
                      event.target.value,
                      catalog.defaults.thinkingLevel ?? "",
                    )
                  }
                >
                  <option value="">Auto (pi default)</option>
                  {availableModels.map(({ provider, model }) => {
                    const key = `${provider}/${model.id}`;
                    return (
                      <option key={key} value={key}>
                        {provider} / {model.name || model.id}
                      </option>
                    );
                  })}
                  {currentDefaultModel &&
                    !availableModels.some(
                      ({ provider, model }) =>
                        `${provider}/${model.id}` === currentDefaultModel,
                    ) && (
                      <option value={currentDefaultModel}>
                        {currentDefaultModel} (unavailable)
                      </option>
                    )}
                </select>
              </label>
              <label>
                Default thinking level
                <select
                  aria-label="Default thinking level"
                  disabled={savingDefaults}
                  value={catalog.defaults.thinkingLevel ?? ""}
                  onChange={(event) =>
                    void updateDefaults(
                      currentDefaultModel,
                      event.target.value,
                    )
                  }
                >
                  <option value="">Auto (pi default)</option>
                  {THINKING_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="models-config-path">
              Config file: <code>{catalog.modelsJsonPath}</code>
            </p>
          </section>
        )}

        <div className="automations-controls">
          <div className="pill-tabs" role="tablist" aria-label="Filter providers">
            {(
              [
                ["configured", "Configured"],
                ["custom", "Custom & modified"],
                ["all", "All providers"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? "selected" : undefined}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="search-field automations-search">
            <Search size={15} />
            <input
              aria-label="Search providers and models"
              placeholder="Search providers, URLs, or model IDs…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {loading ? (
          <p className="empty-note">Loading providers and models…</p>
        ) : visibleProviders.length === 0 ? (
          <div className="automations-empty">
            <Boxes size={36} className="muted" />
            <p className="muted">
              {filter === "configured" && !query.trim()
                ? "No configured providers yet. Add a custom provider or configure a built-in provider."
                : "No matching providers or models."}
            </p>
            <div className="models-pill-wrap">
              {filter !== "all" && (
                <button
                  className="subtle-pill"
                  onClick={() => setFilter("all")}
                >
                  Browse all built-in providers
                </button>
              )}
              <button
                className="new-session inline-cta"
                onClick={() => setEditingProvider("new")}
              >
                <Plus size={16} />
                Add custom provider
              </button>
            </div>
          </div>
        ) : (
          <div className="automations-list">
            {visibleProviders.map(({ provider, models }) => {
              const isSearching = Boolean(query.trim());
              const isOpen =
                isSearching ||
                (expanded[provider.id] ??
                  (!provider.isBuiltin ||
                    (provider.auth.configured && models.length <= 16)));
              const authLabel = provider.auth.configured
                ? formatAuthStatus(provider)
                : "No auth";
              const canResetOrDelete =
                !provider.isBuiltin ||
                provider.inModelsJson ||
                provider.auth.hasStoredCredential;

              return (
                <article className="automation-card models-provider-card" key={provider.id}>
                  <div className="automation-card-head">
                    <div className="models-provider-head-main">
                      <button
                        type="button"
                        className="models-provider-toggle"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [provider.id]: !isOpen,
                          }))
                        }
                      >
                        {isOpen ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                        <span
                          className={`state-dot ${
                            provider.auth.configured ? "done" : ""
                          }`}
                        />
                        <strong>{provider.name}</strong>
                      </button>
                      <div className="models-provider-tags">
                        <code className="models-id-chip">{provider.id}</code>
                        <span className="automation-badge">
                          {!provider.isBuiltin
                            ? "Custom"
                            : provider.inModelsJson
                              ? "Modified"
                              : "Built-in"}
                        </span>
                        <span className="automation-badge">{authLabel}</span>
                      </div>
                    </div>

                    <div className="automation-card-actions">
                      <button
                        type="button"
                        className="subtle-pill"
                        onClick={() => setDiscoveringProvider(provider)}
                        title="Auto-discover models from endpoint"
                      >
                        <Download size={13} />
                        Discover
                      </button>
                      <button
                        type="button"
                        className="subtle-pill"
                        onClick={() => setEditingModel({ provider })}
                        title="Add model manually"
                      >
                        <Plus size={13} />
                        Model
                      </button>
                      <IconButton
                        label={`Edit provider ${provider.name}`}
                        onClick={() => setEditingProvider(provider)}
                      >
                        <Pencil size={15} />
                      </IconButton>
                      {canResetOrDelete && (
                        <IconButton
                          label={
                            provider.isBuiltin
                              ? `Reset overrides for ${provider.name}`
                              : `Delete provider ${provider.name}`
                          }
                          onClick={() => void removeProvider(provider)}
                        >
                          {provider.isBuiltin ? (
                            <RotateCcw size={15} />
                          ) : (
                            <Trash2 size={15} />
                          )}
                        </IconButton>
                      )}
                    </div>
                  </div>

                  <div className="models-provider-meta">
                    {provider.baseUrl && <span>{provider.baseUrl}</span>}
                    {provider.api && <span>{provider.api}</span>}
                    <span>
                      {models.length} {models.length === 1 ? "model" : "models"}
                    </span>
                  </div>

                  {isOpen && (
                    <div className="models-sublist">
                      {models.length === 0 ? (
                        <p className="models-sublist-empty">
                          No models yet. Click <strong>Discover</strong> to fetch
                          from the endpoint or <strong>+ Model</strong> to add one
                          manually.
                        </p>
                      ) : (
                        models.map((model) => (
                          <div className="models-item-row" key={model.id}>
                            <div className="models-item-info">
                              <div className="models-item-title">
                                <strong>{model.name || model.id}</strong>
                              </div>
                              {((model.name && model.name !== model.id) ||
                                model.source !== "builtin") && (
                                <div className="models-item-tags">
                                  {model.name && model.name !== model.id && (
                                    <code>{model.id}</code>
                                  )}
                                  {model.source !== "builtin" && (
                                    <span className="automation-badge">
                                      {model.source === "custom"
                                        ? "Custom"
                                        : "Override"}
                                    </span>
                                  )}
                                </div>
                              )}
                              <small className="models-item-meta">
                                {compactNumber(model.contextWindow)} ctx ·{" "}
                                {compactNumber(model.maxTokens)} out ·{" "}
                                {model.input.join("+")}
                                {model.reasoning
                                  ? ` · reasoning: ${model.supportedThinkingLevels.join(", ")}`
                                  : " · no reasoning"}
                                {model.defaultThinkingLevel
                                  ? ` · default: ${model.defaultThinkingLevel}`
                                  : ""}
                              </small>
                            </div>
                            <div className="models-item-actions">
                              <IconButton
                                label={`Edit model ${model.id}`}
                                onClick={() =>
                                  setEditingModel({ provider, model })
                                }
                              >
                                <Pencil size={14} />
                              </IconButton>
                              {model.source !== "builtin" && (
                                <IconButton
                                  label={
                                    model.source === "overridden"
                                      ? `Reset override for ${model.id}`
                                      : `Delete model ${model.id}`
                                  }
                                  onClick={() => void removeModel(provider, model)}
                                >
                                  {model.source === "overridden" ? (
                                    <RotateCcw size={14} />
                                  ) : (
                                    <Trash2 size={14} />
                                  )}
                                </IconButton>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {editingProvider && catalog && (
        <ProviderEditorModal
          provider={editingProvider === "new" ? undefined : editingProvider}
          knownApis={catalog.knownApis}
          onClose={() => setEditingProvider(undefined)}
          onSaved={(nextCatalog, savedId, discoverAfter) => {
            setCatalog(nextCatalog);
            setEditingProvider(undefined);
            setExpanded((prev) => ({ ...prev, [savedId]: true }));
            if (discoverAfter) {
              const target = nextCatalog.providers.find(
                (item) => item.id === savedId,
              );
              if (target) setDiscoveringProvider(target);
            }
          }}
        />
      )}

      {editingModel && catalog && (
        <ModelEditorModal
          provider={editingModel.provider}
          model={editingModel.model}
          knownApis={catalog.knownApis}
          onClose={() => setEditingModel(undefined)}
          onSaved={(nextCatalog) => {
            setCatalog(nextCatalog);
            setExpanded((prev) => ({
              ...prev,
              [editingModel.provider.id]: true,
            }));
            setEditingModel(undefined);
          }}
        />
      )}

      {discoveringProvider && catalog && (
        <DiscoverModelsModal
          provider={discoveringProvider}
          knownApis={catalog.knownApis}
          onClose={() => setDiscoveringProvider(undefined)}
          onImported={(nextCatalog) => {
            setCatalog(nextCatalog);
            setExpanded((prev) => ({
              ...prev,
              [discoveringProvider.id]: true,
            }));
            setDiscoveringProvider(undefined);
          }}
        />
      )}
    </div>
  );
}

const compactNumber = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
