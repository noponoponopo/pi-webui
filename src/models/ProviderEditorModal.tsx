import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import type {
  ManagedProvider,
  ModelsCatalogResponse,
  ProviderAuthAction,
  ProviderHeaderInput,
  ProviderUpsertInput,
} from "../../shared/models";
import { api } from "../lib/api";
import { ErrorNotice, IconButton, Modal } from "../components/ui";

type AuthChoice = "keep" | "stored" | "config" | "local" | "none";

const PROVIDER_TEMPLATES: {
  label: string;
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  authMode: AuthChoice;
}[] = [
  {
    label: "Ollama",
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    authMode: "local",
  },
  {
    label: "LM Studio",
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    authMode: "local",
  },
  {
    label: "vLLM",
    id: "vllm",
    name: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    authMode: "local",
  },
  {
    label: "OpenAI-compatible",
    id: "custom-openai",
    name: "Custom OpenAI",
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    authMode: "stored",
  },
  {
    label: "Anthropic-compatible",
    id: "custom-anthropic",
    name: "Custom Anthropic",
    baseUrl: "https://api.example.com",
    api: "anthropic-messages",
    authMode: "stored",
  },
  {
    label: "Google Gemini",
    id: "custom-google",
    name: "Custom Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    authMode: "stored",
  },
];

export function formatAuthStatus(provider: ManagedProvider): string {
  if (!provider.auth.configured) return "Not configured";
  if (provider.auth.storedType === "oauth") return "OAuth";
  if (provider.auth.storedKeyPreview) return `Stored key (${provider.auth.storedKeyPreview})`;
  if (provider.auth.modelsJsonApiKeyValue === "none") return "Local (no key)";
  if (provider.auth.modelsJsonApiKeyPreview) return `Configured key (${provider.auth.modelsJsonApiKeyPreview})`;
  if (provider.auth.source === "models_json_command") return "Shell command";
  if (provider.auth.source === "models_json_key") return "Configured key";
  return provider.auth.label || provider.auth.source || "Configured";
}

export function ProviderEditorModal({
  provider,
  knownApis,
  onClose,
  onSaved,
}: {
  provider?: ManagedProvider;
  knownApis: readonly string[];
  onClose: () => void;
  onSaved: (
    catalog: ModelsCatalogResponse,
    savedProviderId: string,
    discoverAfter: boolean,
  ) => void;
}) {
  const isNew = !provider;
  const supportsApiKey = provider ? provider.auth.supportsApiKey : true;
  const [id, setId] = useState(provider?.id ?? "");
  const [name, setName] = useState(provider?.rawName ?? "");
  const [apiType, setApiType] = useState(
    provider?.rawApi ?? (isNew ? "openai-completions" : ""),
  );
  const [baseUrl, setBaseUrl] = useState(provider?.rawBaseUrl ?? "");
  const [authHeader, setAuthHeader] = useState(Boolean(provider?.authHeader));

  const initialAuthChoice = (): AuthChoice => {
    if (!provider) return "stored";
    if (provider.auth.modelsJsonApiKeyValue === "none") return "local";
    if (
      provider.auth.modelsJsonApiKeyKind === "env" ||
      provider.auth.modelsJsonApiKeyKind === "command"
    )
      return "config";
    if (
      provider.auth.hasStoredCredential ||
      provider.auth.modelsJsonApiKeyKind === "literal" ||
      provider.isBuiltin
    )
      return "keep";
    return supportsApiKey ? "stored" : "keep";
  };

  const [authChoice, setAuthChoice] = useState<AuthChoice>(initialAuthChoice);
  const [storedApiKey, setStoredApiKey] = useState("");
  const [configApiKey, setConfigApiKey] = useState(
    provider?.auth.modelsJsonApiKeyValue &&
      provider.auth.modelsJsonApiKeyValue !== "none"
      ? provider.auth.modelsJsonApiKeyValue
      : "",
  );
  const [clearStoredRequested, setClearStoredRequested] = useState(false);

  const [headerRows, setHeaderRows] = useState<ProviderHeaderInput[]>(() =>
    (provider?.headers ?? []).map((entry) => ({
      key: entry.key,
      value: entry.value,
      preserve: entry.masked,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const applyTemplate = (template: (typeof PROVIDER_TEMPLATES)[number]) => {
    setId(template.id);
    setName(template.name);
    setBaseUrl(template.baseUrl);
    setApiType(template.api);
    setAuthChoice(template.authMode);
  };

  const buildAuthAction = (): ProviderAuthAction => {
    if (clearStoredRequested && authChoice === "keep") {
      return { mode: "clear_stored" };
    }
    switch (authChoice) {
      case "keep":
        return { mode: "keep" };
      case "stored":
        return storedApiKey.trim()
          ? { mode: "stored", apiKey: storedApiKey.trim() }
          : { mode: "keep" };
      case "config":
        return { mode: "config", apiKey: configApiKey.trim() };
      case "local":
        return { mode: "local" };
      case "none":
        return { mode: "none" };
    }
  };

  const submit = async (discoverAfter: boolean) => {
    if (busy) return;
    setError("");

    if (
      authChoice === "stored" &&
      (isNew || !provider?.auth.hasStoredCredential) &&
      !storedApiKey.trim()
    ) {
      setError("Enter an API key or choose another authentication option");
      return;
    }
    if (authChoice === "config" && !configApiKey.trim()) {
      setError("Enter an environment variable (e.g. $MY_API_KEY) or command");
      return;
    }

    const headers = headerRows.filter((row) => row.key.trim() && row.value.trim());

    const payload: ProviderUpsertInput = {
      id: id.trim(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      api: apiType.trim(),
      authHeader,
      headers,
      auth: buildAuthAction(),
    };

    setBusy(true);
    try {
      const catalog = await api<ModelsCatalogResponse>("/models/provider", payload);
      onSaved(catalog, payload.id, discoverAfter);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const effectiveBaseUrl = baseUrl.trim() || provider?.baseUrl || "";

  return (
    <Modal
      title={isNew ? "Add provider" : `Edit provider · ${provider.id}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      className="models-modal"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        {isNew && (
          <div className="models-template-bar">
            <span className="models-field-label">Templates</span>
            <div className="models-pill-wrap">
              {PROVIDER_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  type="button"
                  className={id === tpl.id ? "selected-pill" : "subtle-pill"}
                  onClick={() => applyTemplate(tpl)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="models-form-grid">
          <label>
            Provider ID
            <input
              autoFocus={isNew}
              required
              disabled={!isNew}
              placeholder="ollama"
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label>
            Display name
            <input
              placeholder={provider?.name || "Ollama"}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

        <div className="models-form-grid">
          <label>
            Default API protocol
            <select
              value={apiType}
              onChange={(event) => setApiType(event.target.value)}
            >
              <option value="">
                {provider?.isBuiltin
                  ? `Default (${provider.api || "built-in"})`
                  : "Unspecified (set per model)"}
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
            Base URL{isNew ? " *" : " (optional override)"}
            <input
              required={isNew}
              placeholder={provider?.baseUrl || "https://api.openai.com/v1"}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
        </div>

        <fieldset className="models-fieldset">
          <legend>Authentication</legend>
          {provider && (
            <div className="models-auth-summary">
              <span>
                Status: <strong>{formatAuthStatus(provider)}</strong>
              </span>
              {provider.auth.hasStoredCredential && !clearStoredRequested && (
                <button
                  type="button"
                  className="subtle-pill"
                  onClick={() => {
                    setClearStoredRequested(true);
                    setAuthChoice("keep");
                  }}
                >
                  Remove stored key
                </button>
              )}
              {clearStoredRequested && (
                <span className="muted">Stored key will be removed on save</span>
              )}
            </div>
          )}

          <div className="models-pill-wrap">
            {!isNew && (
              <button
                type="button"
                className={authChoice === "keep" ? "selected-pill" : "subtle-pill"}
                onClick={() => setAuthChoice("keep")}
              >
                Keep current
              </button>
            )}
            {supportsApiKey && (
              <button
                type="button"
                className={authChoice === "stored" ? "selected-pill" : "subtle-pill"}
                onClick={() => {
                  setClearStoredRequested(false);
                  setAuthChoice("stored");
                }}
              >
                API key (auth.json)
              </button>
            )}
            <button
              type="button"
              className={authChoice === "config" ? "selected-pill" : "subtle-pill"}
              onClick={() => {
                setClearStoredRequested(false);
                setAuthChoice("config");
              }}
            >
              Env / Command (models.json)
            </button>
            <button
              type="button"
              className={authChoice === "local" ? "selected-pill" : "subtle-pill"}
              onClick={() => {
                setClearStoredRequested(false);
                setAuthChoice("local");
              }}
            >
              No key (local server)
            </button>
            {provider?.inModelsJson &&
              provider.auth.modelsJsonApiKeyKind !== "none" && (
                <button
                  type="button"
                  className={authChoice === "none" ? "selected-pill" : "subtle-pill"}
                  onClick={() => {
                    setClearStoredRequested(false);
                    setAuthChoice("none");
                  }}
                >
                  Clear models.json key
                </button>
              )}
          </div>

          {!supportsApiKey && (
            <p className="settings-note">
              This provider uses OAuth authentication. Run <code>pi</code> in your
              terminal to log in via OAuth.
            </p>
          )}

          {authChoice === "stored" && supportsApiKey && (
            <label className="models-inline-field">
              API key (saved securely in auth.json)
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  provider?.auth.hasStoredCredential
                    ? "Enter new key to replace existing"
                    : "sk-..."
                }
                value={storedApiKey}
                onChange={(event) => setStoredApiKey(event.target.value)}
              />
            </label>
          )}

          {authChoice === "config" && (
            <label className="models-inline-field">
              Env variable ($VAR) or shell command (!cmd)
              <input
                placeholder="$OPENAI_API_KEY or !op read op://..."
                value={configApiKey}
                onChange={(event) => setConfigApiKey(event.target.value)}
              />
            </label>
          )}

          {authChoice === "local" && (
            <p className="settings-note">
              Sets <code>apiKey: &quot;none&quot;</code> in models.json so keyless local
              servers (Ollama, LM Studio, vLLM) are active immediately.
            </p>
          )}

          <label className="models-checkbox-row">
            <input
              type="checkbox"
              checked={authHeader}
              onChange={(event) => setAuthHeader(event.target.checked)}
            />
            <span>Also send Authorization: Bearer header</span>
          </label>
        </fieldset>

        <details className="models-details" open={headerRows.length > 0}>
          <summary>Custom headers ({headerRows.length})</summary>
          <div className="models-headers-list">
            {headerRows.map((row, index) => (
              <div className="models-header-row" key={index}>
                <input
                  placeholder="Header name"
                  value={row.key}
                  onChange={(event) =>
                    setHeaderRows((list) =>
                      list.map((item, i) =>
                        i === index
                          ? { key: event.target.value, value: item.preserve ? "" : item.value, preserve: false }
                          : item,
                      ),
                    )
                  }
                />
                <input
                  type={row.preserve ? "password" : "text"}
                  autoComplete="off"
                  placeholder="Value (supports $ENV_VAR)"
                  value={row.value}
                  onFocus={() => {
                    if (row.preserve) {
                      setHeaderRows((list) =>
                        list.map((item, i) =>
                          i === index ? { ...item, value: "", preserve: false } : item,
                        ),
                      );
                    }
                  }}
                  onChange={(event) =>
                    setHeaderRows((list) =>
                      list.map((item, i) =>
                        i === index
                          ? { ...item, value: event.target.value, preserve: false }
                          : item,
                      ),
                    )
                  }
                />
                <IconButton
                  label="Remove header"
                  onClick={() =>
                    setHeaderRows((list) => list.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
            <button
              type="button"
              className="subtle-pill"
              onClick={() =>
                setHeaderRows((list) => [
                  ...list,
                  { key: "", value: "", preserve: false },
                ])
              }
            >
              <Plus size={13} /> Add header
            </button>
          </div>
        </details>

        <ErrorNotice error={error} />

        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {effectiveBaseUrl && (
            <button
              type="button"
              disabled={busy || !id.trim()}
              onClick={() => void submit(true)}
            >
              <Search size={14} />
              Save &amp; Discover
            </button>
          )}
          <button
            type="submit"
            className="primary"
            disabled={busy || !id.trim()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
