export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevelOption = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevelOption, string | null>>;

export const DEFAULT_REASONING_LEVELS: readonly ThinkingLevelOption[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export function thinkingLevelMapToLevels(
  reasoning: boolean,
  map?: ThinkingLevelMap,
): ThinkingLevelOption[] {
  if (!reasoning) return [];
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function levelsToThinkingLevelMap(
  levels: readonly ThinkingLevelOption[],
  wireValues?: Partial<Record<ThinkingLevelOption, string>>,
): ThinkingLevelMap | undefined {
  const active = new Set(levels);
  const map: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    const isExtended = level === "xhigh" || level === "max";
    if (active.has(level)) {
      const custom = wireValues?.[level]?.trim();
      if (custom && custom !== level) map[level] = custom;
      else if (isExtended) map[level] = level;
    } else if (!isExtended) {
      map[level] = null;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export const KNOWN_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "azure-openai-responses",
  "openai-codex-responses",
  "bedrock-converse-stream",
  "google-vertex",
  "pi-messages",
] as const;

export type ModelInputType = "text" | "image";

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ManagedHeaderEntry = {
  key: string;
  value: string;
  masked: boolean;
};

export type ManagedModel = {
  id: string;
  name: string;
  api?: string;
  rawApi?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  baseThinkingLevelMap?: ThinkingLevelMap;
  supportedThinkingLevels: ThinkingLevelOption[];
  defaultThinkingLevel?: string;
  input: ModelInputType[];
  contextWindow: number;
  maxTokens: number;
  cost?: ModelCostConfig;
  headers?: ManagedHeaderEntry[];
  source: "builtin" | "custom" | "overridden";
  available: boolean;
};

export type ManagedProviderAuth = {
  configured: boolean;
  supportsApiKey: boolean;
  source?: string;
  label?: string;
  hasStoredCredential: boolean;
  storedType?: "api_key" | "oauth";
  storedKeyPreview?: string;
  modelsJsonApiKeyKind: "none" | "env" | "command" | "literal";
  modelsJsonApiKeyValue?: string;
  modelsJsonApiKeyPreview?: string;
};

export type ManagedProvider = {
  id: string;
  name: string;
  rawName?: string;
  isBuiltin: boolean;
  inModelsJson: boolean;
  baseUrl?: string;
  rawBaseUrl?: string;
  api?: string;
  rawApi?: string;
  authHeader?: boolean;
  headers?: ManagedHeaderEntry[];
  auth: ManagedProviderAuth;
  models: ManagedModel[];
};

export type ModelsCatalogResponse = {
  providers: ManagedProvider[];
  defaults: {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  };
  knownApis: readonly string[];
  modelsJsonPath: string;
  configError?: string;
  warning?: string;
};

export type ReasoningSource = "provider-api" | "catalog" | "heuristic" | "default";

export type DiscoveredModel = {
  id: string;
  name: string;
  api?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  supportedThinkingLevels: ThinkingLevelOption[];
  input: ModelInputType[];
  contextWindow: number;
  maxTokens: number;
  cost?: ModelCostConfig;
  reasoningSource: ReasoningSource;
  alreadyConfigured: boolean;
};

export type DiscoverModelsInput = {
  providerId?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export type DiscoverModelsResponse = {
  baseUrl: string;
  endpoint: string;
  models: DiscoveredModel[];
};

export type ProviderAuthAction =
  | { mode: "keep" }
  | { mode: "stored"; apiKey: string }
  | { mode: "clear_stored" }
  | { mode: "config"; apiKey: string }
  | { mode: "local" }
  | { mode: "none" };

export type ProviderHeaderInput = {
  key: string;
  value: string;
  preserve?: boolean;
};

export type ProviderUpsertInput = {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  headers?: ProviderHeaderInput[];
  auth?: ProviderAuthAction;
};

export type ModelUpsertInput = {
  providerId: string;
  originalId?: string;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  defaultThinkingLevel?: string;
  input: ModelInputType[];
  contextWindow: number;
  maxTokens: number;
  cost?: ModelCostConfig;
  headers?: Record<string, string>;
};

export type ModelDefaultsInput = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
};
