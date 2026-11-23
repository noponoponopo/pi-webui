import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import {
  ModelRuntime,
  readStoredCredential,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  THINKING_LEVELS,
  KNOWN_MODEL_APIS,
  levelsToThinkingLevelMap,
  type DiscoverModelsInput,
  type DiscoverModelsResponse,
  type DiscoveredModel,
  type ManagedHeaderEntry,
  type ManagedModel,
  type ManagedProvider,
  type ManagedProviderAuth,
  type ModelCostConfig,
  type ModelDefaultsInput,
  type ModelInputType,
  type ModelsCatalogResponse,
  type ModelUpsertInput,
  type ProviderHeaderInput,
  type ProviderUpsertInput,
  type ReasoningSource,
  type ThinkingLevelMap,
  type ThinkingLevelOption,
} from "../shared/models";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PURE_ENV_REF_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const MAX_DISCOVERY_BYTES = 10 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

type RawModelRecord = Record<string, unknown>;
type RawProviderRecord = Record<string, unknown> & {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  oauth?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: RawModelRecord[];
  modelOverrides?: Record<string, RawModelRecord>;
};
type RawModelsJson = {
  providers: Record<string, RawProviderRecord>;
};

type BuiltinIndexEntry = {
  provider: string;
  model: Model<Api>;
  normId: string;
  tailId: string;
  isBuiltin?: boolean;
};

const OFFICIAL_PROVIDER_HINTS: Array<[RegExp, readonly string[]]> = [
  [/^glm-/i, ["zai", "zai-coding-cn"]],
  [/^gpt-oss/i, ["openrouter", "together", "huggingface", "fireworks", "groq"]],
  [/^(?:gpt-|o1|o3|o4)/i, ["openai", "openai-codex"]],
  [/^claude-/i, ["anthropic"]],
  [/^(?:gemini-|gemma-)/i, ["google"]],
  [/^grok-/i, ["xai"]],
  [/^(?:mistral-|magistral-|codestral-|devstral-)/i, ["mistral"]],
  [/^deepseek-/i, ["openrouter", "qwen-token-plan", "huggingface", "nvidia"]],
  [/^qwen/i, ["qwen-token-plan", "huggingface", "openrouter", "groq"]],
  [/^kimi-/i, ["fireworks", "huggingface", "openrouter", "qwen-token-plan"]],
];

function buildModelLookupKeys(rawId: string): string[] {
  const clean = rawId.trim().toLowerCase();
  if (!clean) return [];
  const afterSlash = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
  const vendorDotStripped = afterSlash.replace(
    /^(?:(?:us-gov|global)\.)?(?:amazon|anthropic|cohere|deepseek|google|meta|mistral|moonshotai?|openai|qwen|xai|zai(?:-org)?)\./i,
    "",
  );
  const candidates = new Set<string>([clean, afterSlash, vendorDotStripped]);
  for (const base of [afterSlash, vendorDotStripped]) {
    const noVariant = base.replace(/[:@](?:batch|free|exacto|q[0-9a-z_-]+)$/i, "");
    candidates.add(noVariant);
    const noRuntime = noVariant.replace(
      /-(?:cpu|gpu|fp16|fp8|bf16|int4|int8|awq|gptq|gguf|mlx)$/i,
      "",
    );
    candidates.add(noRuntime);
    candidates.add(noRuntime.replace(/-(?:20\d{6}|\d{4})$/, ""));
  }
  return Array.from(candidates).filter(Boolean);
}

const BUILTIN_PROVIDER_IDS = new Set<string>(getBuiltinProviders());
const BUILTIN_MODEL_INDEX = (() => {
  const byFullKey = new Map<string, Model<Api>>();
  const byNormKey = new Map<string, BuiltinIndexEntry[]>();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider as BuiltinProvider)) {
      const normId = model.id.trim().toLowerCase();
      byFullKey.set(`${provider}\0${normId}`, model);
      const tailId = normId.includes("/") ? normId.slice(normId.lastIndexOf("/") + 1) : normId;
      const entry: BuiltinIndexEntry = { provider, model, normId, tailId };
      for (const key of buildModelLookupKeys(model.id)) {
        let bucket = byNormKey.get(key);
        if (!bucket) {
          bucket = [];
          byNormKey.set(key, bucket);
        }
        bucket.push(entry);
      }
    }
  }
  return { byFullKey, byNormKey };
})();

function stripJsonComments(content: string): string {
  let out = "";
  let inString = false;
  let escaping = false;
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (inString) {
      out += ch;
      if (escaping) escaping = false;
      else if (ch === "\\") escaping = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function assertSafeKey(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const trimmed = value.trim();
  if (!trimmed || FORBIDDEN_KEYS.has(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function validateProviderId(id: string): string {
  const trimmed = assertSafeKey(id, "provider ID");
  if (!PROVIDER_ID_RE.test(trimmed)) {
    throw new Error(
      "Provider ID must start with a letter or digit and use only letters, digits, '.', '_' or '-'",
    );
  }
  return trimmed;
}

function validateModelId(id: string): string {
  const trimmed = assertSafeKey(id, "model ID");
  if (trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) {
    throw new Error("Invalid model ID");
  }
  return trimmed;
}

function validateThinkingLevel(level: string): ThinkingLevelOption {
  if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`Invalid thinking level: ${String(level)}`);
  }
  return level as ThinkingLevelOption;
}

function sanitizeHeadersRecord(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    if (!key || FORBIDDEN_KEYS.has(key) || /[\r\n\0]/.test(key)) continue;
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (!value || /[\r\n\0]/.test(value)) continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeProviderHeadersInput(
  entries: ProviderHeaderInput[] | undefined,
  existing: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!Array.isArray(entries)) return undefined;
  const result: Record<string, string> = {};
  for (const item of entries) {
    if (!item || typeof item !== "object" || typeof item.key !== "string") continue;
    const key = item.key.trim();
    if (!key || FORBIDDEN_KEYS.has(key) || /[\r\n\0]/.test(key)) continue;
    if (item.preserve) {
      const existingValue = existing && Object.hasOwn(existing, key) ? existing[key] : undefined;
      if (typeof existingValue === "string" && existingValue.trim()) {
        result[key] = existingValue;
      }
      continue;
    }
    if (typeof item.value !== "string") continue;
    const value = item.value.trim();
    if (!value || /[\r\n\0]/.test(value)) continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function maskHeaderEntries(
  headers: Record<string, string> | undefined,
): ManagedHeaderEntry[] | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const list: ManagedHeaderEntry[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    if (value.startsWith("!") || PURE_ENV_REF_RE.test(value)) {
      list.push({ key, value, masked: false });
    } else {
      list.push({ key, value: maskSecret(value), masked: true });
    }
  }
  return list.length > 0 ? list : undefined;
}

function sanitizeThinkingLevelMap(
  map: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const result: ThinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(map, level)) continue;
    const value = map[level];
    if (value === null) {
      result[level] = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) result[level] = trimmed;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeCost(
  cost: ModelCostConfig | undefined,
  existingCost?: unknown,
): Record<string, unknown> | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const out: Record<string, unknown> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const field of fields) {
    const value = Number(cost[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid cost.${field}`);
    }
    out[field] = value;
  }
  if (
    existingCost &&
    typeof existingCost === "object" &&
    Array.isArray((existingCost as { tiers?: unknown }).tiers)
  ) {
    out.tiers = structuredClone((existingCost as { tiers: unknown }).tiers);
  }
  return out;
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function classifyModelsJsonApiKey(
  rawKey: string | undefined,
): Pick<
  ManagedProviderAuth,
  "modelsJsonApiKeyKind" | "modelsJsonApiKeyValue" | "modelsJsonApiKeyPreview"
> {
  if (!rawKey) return { modelsJsonApiKeyKind: "none" };
  if (rawKey.startsWith("!")) {
    return { modelsJsonApiKeyKind: "command", modelsJsonApiKeyValue: rawKey };
  }
  if (PURE_ENV_REF_RE.test(rawKey)) {
    return { modelsJsonApiKeyKind: "env", modelsJsonApiKeyValue: rawKey };
  }
  if (rawKey === "none" || rawKey === "ollama" || rawKey === "lm-studio") {
    return {
      modelsJsonApiKeyKind: "literal",
      modelsJsonApiKeyValue: rawKey,
      modelsJsonApiKeyPreview: rawKey,
    };
  }
  return {
    modelsJsonApiKeyKind: "literal",
    modelsJsonApiKeyPreview: maskSecret(rawKey),
  };
}

function scoreCatalogEntry(
  entry: BuiltinIndexEntry,
  targetProvider: string | undefined,
  targetApi: string | undefined,
  queryTail: string,
): number {
  let score = entry.isBuiltin !== false ? 2_000 : 0;
  if (entry.isBuiltin !== false && targetProvider && entry.provider === targetProvider) {
    score += 10_000;
  }
  for (const [re, preferred] of OFFICIAL_PROVIDER_HINTS) {
    if (re.test(queryTail)) {
      const idx = preferred.indexOf(entry.provider);
      if (idx >= 0) score += 500 - idx * 50;
    }
  }
  if (targetApi && entry.model.api === targetApi) score += 250;
  if (entry.model.thinkingLevelMap && typeof entry.model.thinkingLevelMap === "object") {
    score += 300 + Object.keys(entry.model.thinkingLevelMap).length * 10;
    // together catalogs frequently omit supported high/max/low entries
    if (entry.provider === "together") score -= 220;
  }
  if (entry.tailId === queryTail || entry.normId === queryTail) score += 80;
  return score;
}

function findBuiltinModelMatch(
  providerId: string | undefined,
  modelId: string,
  targetApi?: string,
  extraModels?: readonly Model<Api>[],
): Model<Api> | undefined {
  const normQuery = modelId.trim().toLowerCase();
  if (!normQuery) return undefined;
  if (providerId) {
    const exact = BUILTIN_MODEL_INDEX.byFullKey.get(`${providerId}\0${normQuery}`);
    if (exact) return exact;
  }

  const keys = buildModelLookupKeys(modelId);
  const queryTail = keys[keys.length - 1] ?? normQuery;
  const candidates: BuiltinIndexEntry[] = [];
  const seen = new Set<BuiltinIndexEntry>();
  for (const key of keys) {
    for (const entry of BUILTIN_MODEL_INDEX.byNormKey.get(key) ?? []) {
      if (!seen.has(entry)) {
        seen.add(entry);
        candidates.push(entry);
      }
    }
  }

  if (extraModels) {
    const extraKeySet = new Set(keys);
    for (const model of extraModels) {
      // Never match against stale models from the same provider being discovered/re-inferred.
      if (providerId && model.provider === providerId) continue;
      const entryKeys = buildModelLookupKeys(model.id);
      if (entryKeys.some((k) => extraKeySet.has(k))) {
        const normId = model.id.trim().toLowerCase();
        const tailId = normId.includes("/") ? normId.slice(normId.lastIndexOf("/") + 1) : normId;
        candidates.push({ provider: model.provider, model, normId, tailId, isBuiltin: false });
      }
    }
  }

  if (candidates.length === 0) return undefined;
  candidates.sort(
    (a, b) =>
      scoreCatalogEntry(b, providerId, targetApi, queryTail) -
      scoreCatalogEntry(a, providerId, targetApi, queryTail),
  );
  return candidates[0]?.model;
}

function normalizeMatchedThinkingMap(
  model: Pick<Model<Api>, "api" | "reasoning" | "thinkingLevelMap">,
  targetApi?: string,
): ThinkingLevelMap | undefined {
  if (!model.reasoning) return undefined;
  if (!model.thinkingLevelMap) return undefined;
  // Avoid leaking provider-specific wire tokens (e.g. Google GenAI "MINIMAL"/"HIGH") across APIs.
  if (targetApi && model.api && targetApi !== model.api) {
    const levels = computeSupportedThinkingLevels(true, model.thinkingLevelMap);
    return levelsToThinkingLevelMap(levels);
  }
  return { ...model.thinkingLevelMap };
}

function heuristicReasoningForId(modelId: string): {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  matched: boolean;
} {
  const id = modelId.toLowerCase();
  if (
    /(^|[/:_-])(embedding|embed|rerank|reranker|whisper|tts|stt|asr|transcrib|moderation|classifier|guard|instruct)($|[/:_.-])/.test(
      id,
    )
  ) {
    return { reasoning: false, matched: true };
  }

  const isReasoning =
    /(^|[/:_-])(o1|o3|o4|gpt-5|gpt-oss|deepseek-r1|deepseek-v4(\.1)?|deepseek-reasoner|qwq|qwen3(\.[568])?|gemma-?4|claude-3[-.]7|claude-(sonnet|opus|haiku)-4|gemini-2\.5|gemini-3|grok-3-mini|grok-4|glm-4\.[56]|glm-5(\.[0-9]+)?|kimi-k2(-thinking|\.[5-9])?|kimi-k3|minimax-m2|magistral|thinking|reasoner|r1)($|[/:_.-])/.test(
      id,
    );
  if (!isReasoning) return { reasoning: false, matched: false };

  if (/glm-5\.[3-9]/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      matched: true,
    };
  }
  if (/glm-5\.2/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
      matched: true,
    };
  }
  if (/glm-(4\.[56]|5(?:\.[01])?)(?:$|[/:_.-])/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
      matched: true,
    };
  }
  if (/gpt-oss/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
      matched: true,
    };
  }
  if (/deepseek-v4\.1/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      matched: true,
    };
  }
  if (/deepseek-(v4|r1)/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
      matched: true,
    };
  }
  if (/gemma-?4/.test(id)) {
    return {
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: "minimal", low: null, medium: null, high: "high", xhigh: null, max: null },
      matched: true,
    };
  }
  if (
    /(gpt-5\.[2-9]|gpt-5-codex|o3|o4-mini|claude-(opus|sonnet)-4[-.][6-9])/.test(
      id,
    )
  ) {
    return {
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
      matched: true,
    };
  }
  return { reasoning: true, matched: true };
}

function computeSupportedThinkingLevels(
  reasoning: boolean,
  thinkingLevelMap?: ThinkingLevelMap,
): ThinkingLevelOption[] {
  if (!reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function inferModelMetadata(
  providerId: string | undefined,
  modelId: string,
  targetApi?: string,
  extraModels?: readonly Model<Api>[],
): DiscoveredModel {
  const id = modelId.trim();
  const catalogMatch = findBuiltinModelMatch(providerId, id, targetApi, extraModels);
  if (catalogMatch) {
    const thinkingLevelMap = normalizeMatchedThinkingMap(catalogMatch, targetApi);
    return {
      id,
      name: catalogMatch.name || id,
      api: targetApi || catalogMatch.api,
      reasoning: catalogMatch.reasoning,
      thinkingLevelMap,
      supportedThinkingLevels: computeSupportedThinkingLevels(
        catalogMatch.reasoning,
        thinkingLevelMap,
      ),
      input: [...catalogMatch.input],
      contextWindow: catalogMatch.contextWindow,
      maxTokens: catalogMatch.maxTokens,
      cost: {
        input: catalogMatch.cost.input,
        output: catalogMatch.cost.output,
        cacheRead: catalogMatch.cost.cacheRead,
        cacheWrite: catalogMatch.cost.cacheWrite,
      },
      reasoningSource: "catalog",
      alreadyConfigured: false,
    };
  }

  const heuristic = heuristicReasoningForId(id);
  const input: ModelInputType[] =
    /(vision|vl|4o|4\.1|gpt-5|claude-3|claude-(sonnet|opus|haiku)-4|gemini-1\.5|gemini-2|gemini-3|gemma-?4|pixtral|llava|qwen.*vl)/i.test(
      id,
    )
      ? ["text", "image"]
      : ["text"];
  return {
    id,
    name: id,
    ...(targetApi ? { api: targetApi } : {}),
    reasoning: heuristic.reasoning,
    thinkingLevelMap: heuristic.thinkingLevelMap,
    supportedThinkingLevels: computeSupportedThinkingLevels(
      heuristic.reasoning,
      heuristic.thinkingLevelMap,
    ),
    input,
    contextWindow: 128000,
    maxTokens: 16384,
    reasoningSource: heuristic.matched ? "heuristic" : "default",
    alreadyConfigured: false,
  };
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DISCOVERY_BYTES) {
      await reader.cancel();
      throw new Error("Discovery response exceeded 10 MiB limit");
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return text.trim() ? JSON.parse(text) : {};
}

function normalizeHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Invalid base URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http:// or https://");
  }
  return url;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  const data = await readJsonWithLimit(response).catch(() => undefined);
  return { status: response.status, data };
}

function errorDetailFromPayload(status: number, data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const nested =
      typeof obj.error === "object" && obj.error !== null
        ? (obj.error as Record<string, unknown>).message
        : obj.error;
    const msg =
      (typeof nested === "string" && nested) ||
      (typeof obj.message === "string" && obj.message);
    if (msg) return `HTTP ${status}: ${msg}`;
  }
  return `HTTP ${status}`;
}

export class ModelsManager {
  readonly modelsJsonPath: string;
  readonly authJsonPath: string;
  readonly modelsStorePath: string;
  private queue: Promise<void> = Promise.resolve();
  private runtimePromise?: Promise<ModelRuntime>;

  constructor(
    readonly agentDir: string,
    private readonly onReload: () => Promise<void> | void,
  ) {
    this.modelsJsonPath = join(agentDir, "models.json");
    this.authJsonPath = join(agentDir, "auth.json");
    this.modelsStorePath = join(agentDir, "models-store.json");
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async getRuntime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = ModelRuntime.create({
        authPath: this.authJsonPath,
        modelsPath: this.modelsJsonPath,
        modelsStorePath: this.modelsStorePath,
        allowModelNetwork: false,
      }).catch((error) => {
        this.runtimePromise = undefined;
        throw error;
      });
    }
    return this.runtimePromise;
  }

  private readModelsJsonRaw(): { text?: string; data: RawModelsJson } {
    if (!existsSync(this.modelsJsonPath)) {
      return { data: { providers: {} } };
    }
    const text = readFileSync(this.modelsJsonPath, "utf8");
    const stripped = stripJsonComments(text.replace(/^\uFEFF/, "")).trim();
    if (!stripped) return { text, data: { providers: {} } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      throw new Error(
        `Existing models.json contains invalid JSON and cannot be safely edited automatically (${this.modelsJsonPath})`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { providers?: unknown }).providers !== "object" ||
      (parsed as { providers?: unknown }).providers === null ||
      Array.isArray((parsed as { providers?: unknown }).providers)
    ) {
      throw new Error("Existing models.json must be an object with a 'providers' map");
    }
    return { text, data: structuredClone(parsed) as RawModelsJson };
  }

  private writeModelsJsonAtomic(data: RawModelsJson): void {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.modelsJsonPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.modelsJsonPath);
  }

  private restoreModelsJson(previousText: string | undefined): void {
    if (previousText === undefined) {
      rmSync(this.modelsJsonPath, { force: true });
      return;
    }
    const tmp = `${this.modelsJsonPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, previousText, { mode: 0o600 });
    renameSync(tmp, this.modelsJsonPath);
  }

  private async commitModelsJson(
    mutator: (data: RawModelsJson) => Promise<void> | void,
  ): Promise<ModelRuntime> {
    const runtime = await this.getRuntime();
    const { text: previousText, data } = this.readModelsJsonRaw();
    await mutator(data);
    this.writeModelsJsonAtomic(data);
    await runtime.refresh({ allowNetwork: false });
    const error = runtime.getError();
    if (error) {
      this.restoreModelsJson(previousText);
      await runtime.refresh({ allowNetwork: false });
      throw new Error(error);
    }
    return runtime;
  }

  private settingsManager(): SettingsManager {
    return SettingsManager.create(this.agentDir, this.agentDir);
  }

  private async buildCatalog(
    runtime: ModelRuntime,
    warning?: string,
  ): Promise<ModelsCatalogResponse> {
    let rawProviders: Record<string, RawProviderRecord> = {};
    try {
      rawProviders = this.readModelsJsonRaw().data.providers;
    } catch {
      rawProviders = {};
    }

    const settings = this.settingsManager();
    const modelThinkingLevels = settings.getAllModelThinkingLevels();
    const storedCredentials = new Set(
      (await runtime.listCredentials()).map((item) => item.providerId),
    );
    const availableKeys = new Set(
      runtime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
    );

    const providerIds = new Set<string>([
      ...runtime.getProviders().map((provider) => provider.id),
      ...Object.keys(rawProviders),
    ]);

    const providers: ManagedProvider[] = [];
    for (const providerId of providerIds) {
      const runtimeProvider = runtime.getProvider(providerId);
      const rawConfig = rawProviders[providerId];
      const isBuiltin = BUILTIN_PROVIDER_IDS.has(providerId);
      const inModelsJson = Boolean(rawConfig);
      const authStatus = runtime.getProviderAuthStatus(providerId);
      const storedCredential = storedCredentials.has(providerId)
        ? readStoredCredential(providerId, this.authJsonPath)
        : undefined;
      const keyClassification = classifyModelsJsonApiKey(rawConfig?.apiKey);
      const supportsApiKey = Boolean(runtimeProvider?.auth.apiKey) || !isBuiltin;

      const auth: ManagedProviderAuth = {
        configured: authStatus.configured,
        supportsApiKey,
        source: authStatus.source,
        label: authStatus.label,
        hasStoredCredential: Boolean(storedCredential),
        storedType: storedCredential?.type,
        storedKeyPreview:
          storedCredential?.type === "api_key" && storedCredential.key
            ? maskSecret(storedCredential.key)
            : undefined,
        ...keyClassification,
      };

      const customModelIds = new Set(
        (rawConfig?.models ?? [])
          .map((item) => (typeof item.id === "string" ? item.id : ""))
          .filter(Boolean),
      );
      const overrideModelIds = new Set(Object.keys(rawConfig?.modelOverrides ?? {}));

      const runtimeModels = runtimeProvider?.getModels() ?? [];
      const seenModelIds = new Set<string>();
      const models: ManagedModel[] = [];

      for (const model of runtimeModels) {
        seenModelIds.add(model.id);
        const rawCustom = rawConfig?.models?.find((item) => item.id === model.id);
        const rawOverride = rawConfig?.modelOverrides?.[model.id];
        const builtinBase = isBuiltin
          ? BUILTIN_MODEL_INDEX.byFullKey.get(`${providerId}\0${model.id}`)
          : undefined;
        const source: ManagedModel["source"] = customModelIds.has(model.id)
          ? "custom"
          : overrideModelIds.has(model.id)
            ? "overridden"
            : "builtin";
        const rawHeaders =
          (rawCustom?.headers as Record<string, string> | undefined) ??
          (rawOverride?.headers as Record<string, string> | undefined);

        models.push({
          id: model.id,
          name: model.name || model.id,
          api: model.api,
          rawApi:
            typeof rawCustom?.api === "string" ? rawCustom.api : undefined,
          baseUrl: model.baseUrl,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap
            ? { ...model.thinkingLevelMap }
            : undefined,
          baseThinkingLevelMap: builtinBase?.thinkingLevelMap
            ? { ...builtinBase.thinkingLevelMap }
            : undefined,
          supportedThinkingLevels: computeSupportedThinkingLevels(
            model.reasoning,
            model.thinkingLevelMap,
          ),
          defaultThinkingLevel: modelThinkingLevels[`${providerId}/${model.id}`],
          input: [...model.input],
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: {
            input: model.cost.input,
            output: model.cost.output,
            cacheRead: model.cost.cacheRead,
            cacheWrite: model.cost.cacheWrite,
          },
          headers: maskHeaderEntries(rawHeaders),
          source,
          available: availableKeys.has(`${providerId}\0${model.id}`),
        });
      }

      for (const rawModel of rawConfig?.models ?? []) {
        const modelId = typeof rawModel.id === "string" ? rawModel.id : "";
        if (!modelId || seenModelIds.has(modelId)) continue;
        const reasoning = Boolean(rawModel.reasoning);
        const thinkingLevelMap = rawModel.thinkingLevelMap as
          | ThinkingLevelMap
          | undefined;
        models.push({
          id: modelId,
          name:
            typeof rawModel.name === "string" && rawModel.name
              ? rawModel.name
              : modelId,
          api: typeof rawModel.api === "string" ? rawModel.api : rawConfig?.api,
          rawApi: typeof rawModel.api === "string" ? rawModel.api : undefined,
          baseUrl:
            typeof rawModel.baseUrl === "string"
              ? rawModel.baseUrl
              : rawConfig?.baseUrl,
          reasoning,
          thinkingLevelMap,
          supportedThinkingLevels: computeSupportedThinkingLevels(
            reasoning,
            thinkingLevelMap,
          ),
          defaultThinkingLevel: modelThinkingLevels[`${providerId}/${modelId}`],
          input: Array.isArray(rawModel.input)
            ? (rawModel.input as ModelInputType[])
            : ["text"],
          contextWindow:
            typeof rawModel.contextWindow === "number"
              ? rawModel.contextWindow
              : 128000,
          maxTokens:
            typeof rawModel.maxTokens === "number" ? rawModel.maxTokens : 16384,
          cost: rawModel.cost as ModelCostConfig | undefined,
          headers: maskHeaderEntries(
            rawModel.headers as Record<string, string> | undefined,
          ),
          source: "custom",
          available: false,
        });
      }

      models.sort((a, b) => {
        if (a.source !== b.source) {
          const rank = { custom: 0, overridden: 1, builtin: 2 };
          return rank[a.source] - rank[b.source];
        }
        return (a.name || a.id).localeCompare(b.name || b.id);
      });

      providers.push({
        id: providerId,
        name: runtimeProvider?.name || rawConfig?.name || providerId,
        rawName: rawConfig?.name,
        isBuiltin,
        inModelsJson,
        baseUrl: rawConfig?.baseUrl ?? runtimeProvider?.baseUrl,
        rawBaseUrl: rawConfig?.baseUrl,
        api: rawConfig?.api ?? runtimeModels[0]?.api,
        rawApi: rawConfig?.api,
        authHeader: rawConfig?.authHeader,
        headers: maskHeaderEntries(rawConfig?.headers),
        auth,
        models,
      });
    }

    providers.sort((a, b) => {
      const aCustom = !a.isBuiltin ? 0 : a.inModelsJson || a.auth.configured ? 1 : 2;
      const bCustom = !b.isBuiltin ? 0 : b.inModelsJson || b.auth.configured ? 1 : 2;
      if (aCustom !== bCustom) return aCustom - bCustom;
      return a.name.localeCompare(b.name);
    });

    return {
      providers,
      defaults: {
        provider: settings.getDefaultProvider(),
        model: settings.getDefaultModel(),
        thinkingLevel: settings.getDefaultThinkingLevel(),
      },
      knownApis: KNOWN_MODEL_APIS,
      modelsJsonPath: this.modelsJsonPath,
      configError: runtime.getError(),
      ...(warning ? { warning } : {}),
    };
  }

  async getCatalog(): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      const runtime = await this.getRuntime();
      await runtime.refresh({ allowNetwork: false });
      return this.buildCatalog(runtime);
    });
  }

  async refreshCatalog(providerId?: string): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      const runtime = await this.getRuntime();
      const result = await runtime.refresh({
        allowNetwork: true,
        force: true,
        ...(providerId ? { providers: [validateProviderId(providerId)] } : {}),
      });
      let warning: string | undefined;
      if (result.errors.size > 0) {
        const firstError = [...result.errors.values()][0];
        if (providerId && firstError) throw firstError;
        const summary = [...result.errors.entries()]
          .slice(0, 3)
          .map(([id, err]) => `${id}: ${err.message}`)
          .join("; ");
        warning = `Some provider catalogs failed to refresh (${result.errors.size}): ${summary}`;
      }
      await this.onReload();
      return this.buildCatalog(runtime, warning);
    });
  }

  async upsertProvider(input: ProviderUpsertInput): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      const id = validateProviderId(input.id);
      const isBuiltin = BUILTIN_PROVIDER_IDS.has(id);
      const auth = input.auth ?? { mode: "keep" };

      const previousRuntime = await this.getRuntime();
      const runtimeProvider = previousRuntime.getProvider(id);
      if (auth.mode === "stored" && isBuiltin && !runtimeProvider?.auth.apiKey) {
        throw new Error(`Provider "${id}" uses OAuth and does not support API key login`);
      }

      const { text: previousText } = this.readModelsJsonRaw();
      const hadStoredCred = (await previousRuntime.listCredentials()).some(
        (c) => c.providerId === id,
      );

      let pendingStoredKey: string | undefined;
      let clearStored = false;

      const runtime = await this.commitModelsJson((data) => {
        const prevEntry = data.providers[id];
        const entry: RawProviderRecord = prevEntry
          ? structuredClone(prevEntry)
          : {};

        if (typeof input.name === "string" && input.name.trim()) {
          entry.name = input.name.trim();
        } else {
          delete entry.name;
        }

        if (typeof input.baseUrl === "string" && input.baseUrl.trim()) {
          normalizeHttpUrl(input.baseUrl);
          entry.baseUrl = input.baseUrl.trim();
        } else {
          delete entry.baseUrl;
        }

        if (typeof input.api === "string" && input.api.trim()) {
          entry.api = input.api.trim();
        } else {
          delete entry.api;
        }

        if (input.authHeader === true) entry.authHeader = true;
        else delete entry.authHeader;

        if (input.headers !== undefined) {
          const nextHeaders = sanitizeProviderHeadersInput(
            input.headers,
            prevEntry?.headers,
          );
          if (nextHeaders) entry.headers = nextHeaders;
          else delete entry.headers;
        }

        if (auth.mode === "stored") {
          const key = typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
          if (!key) throw new Error("API key is required");
          delete entry.apiKey;
          pendingStoredKey = key;
        } else if (auth.mode === "clear_stored") {
          clearStored = true;
        } else if (auth.mode === "config") {
          const key = typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
          if (!key) throw new Error("API key expression is required");
          entry.apiKey = key;
          clearStored = hadStoredCred;
        } else if (auth.mode === "local") {
          entry.apiKey = "none";
          clearStored = hadStoredCred;
        } else if (auth.mode === "none") {
          delete entry.apiKey;
        }

        if (!isBuiltin && !entry.baseUrl && !entry.models?.length) {
          throw new Error("Base URL is required for custom providers");
        }

        const hasMeaningfulOverride =
          Boolean(entry.baseUrl) ||
          Boolean(entry.apiKey) ||
          Boolean(entry.headers && Object.keys(entry.headers).length > 0) ||
          Boolean(entry.compat) ||
          Boolean(entry.oauth) ||
          entry.authHeader !== undefined ||
          Boolean(entry.models && entry.models.length > 0) ||
          Boolean(entry.modelOverrides && Object.keys(entry.modelOverrides).length > 0);

        if (isBuiltin && !hasMeaningfulOverride) {
          delete data.providers[id];
        } else {
          data.providers[id] = entry;
        }
      });

      try {
        if (clearStored) {
          await runtime.logout(id);
        }
        if (pendingStoredKey !== undefined) {
          await runtime.login(id, "api_key", {
            prompt: async (prompt) => {
              if (prompt.type === "select") {
                if (id === "amazon-bedrock") return "bearer-token";
                if (id === "google-vertex") return "api-key";
                throw new Error(
                  `Provider "${id}" requires interactive setup in the pi CLI`,
                );
              }
              return pendingStoredKey!;
            },
            notify: () => {},
          });
        }
      } catch (error) {
        this.restoreModelsJson(previousText);
        await runtime.refresh({ allowNetwork: false });
        throw error;
      }

      await this.onReload();
      return this.buildCatalog(runtime);
    });
  }

  async deleteProvider(
    providerId: string,
    removeStoredCredential = true,
  ): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      const id = validateProviderId(providerId);
      const isBuiltin = BUILTIN_PROVIDER_IDS.has(id);

      const runtime = await this.commitModelsJson((data) => {
        delete data.providers[id];
      });

      if (removeStoredCredential) {
        await runtime.logout(id);
      }

      if (!isBuiltin) {
        const settings = this.settingsManager();
        for (const key of Object.keys(settings.getAllModelThinkingLevels())) {
          if (key.startsWith(`${id}/`)) {
            settings.removeModelThinkingLevel(id, key.slice(id.length + 1));
          }
        }
        if (settings.getDefaultProvider() === id) {
          settings.setDefaultModelAndProvider(
            undefined as unknown as string,
            undefined as unknown as string,
          );
        }
        await settings.flush();
      }

      await this.onReload();
      return this.buildCatalog(runtime);
    });
  }

  async upsertModel(input: ModelUpsertInput): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      const providerId = validateProviderId(input.providerId);
      const id = validateModelId(input.id);
      const originalId = input.originalId ? validateModelId(input.originalId) : undefined;
      const isBuiltin = BUILTIN_PROVIDER_IDS.has(providerId);

      const contextWindow = Math.round(Number(input.contextWindow));
      const maxTokens = Math.round(Number(input.maxTokens));
      if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
        throw new Error("Context window must be a positive number");
      }
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
        throw new Error("Max tokens must be a positive number");
      }

      const modalities = Array.from(
        new Set(
          (Array.isArray(input.input) ? input.input : ["text"]).filter(
            (item): item is ModelInputType => item === "text" || item === "image",
          ),
        ),
      );
      if (!modalities.length) modalities.push("text");

      const requestedMap = input.reasoning
        ? sanitizeThinkingLevelMap(input.thinkingLevelMap)
        : undefined;
      const headers =
        input.headers !== undefined ? sanitizeHeadersRecord(input.headers) : undefined;
      if (typeof input.baseUrl === "string" && input.baseUrl.trim()) {
        normalizeHttpUrl(input.baseUrl);
      }

      let supportedLevels = computeSupportedThinkingLevels(
        Boolean(input.reasoning),
        requestedMap,
      );

      const runtime = await this.commitModelsJson((data) => {
        const existingProvider = data.providers[providerId]
          ? structuredClone(data.providers[providerId])
          : undefined;
        if (!isBuiltin && !existingProvider) {
          throw new Error(`Provider "${providerId}" not found`);
        }

        const providerEntry: RawProviderRecord = existingProvider ?? {};
        const targetId = originalId ?? id;
        const customModels = Array.isArray(providerEntry.models)
          ? [...providerEntry.models]
          : [];
        const existingCustomIdx = customModels.findIndex(
          (item) => item.id === targetId,
        );
        const isBuiltinTarget =
          isBuiltin && existingCustomIdx < 0 && id === targetId;

        if (isBuiltinTarget) {
          const prevOverride = providerEntry.modelOverrides?.[id] ?? {};
          const override: RawModelRecord = { ...prevOverride };
          if (typeof input.name === "string" && input.name.trim()) {
            override.name = input.name.trim();
          } else {
            delete override.name;
          }
          override.reasoning = Boolean(input.reasoning);

          const builtinBase = BUILTIN_MODEL_INDEX.byFullKey.get(
            `${providerId}\0${id}`,
          );
          let effectiveMap = requestedMap ? { ...requestedMap } : undefined;
          if (input.reasoning && builtinBase?.thinkingLevelMap) {
            for (const level of THINKING_LEVELS) {
              const baseValue = builtinBase.thinkingLevelMap[level];
              const isExtended = level === "xhigh" || level === "max";
              const enabledInRequest = isExtended
                ? Boolean(effectiveMap && effectiveMap[level] !== undefined && effectiveMap[level] !== null)
                : effectiveMap?.[level] !== null;
              if (baseValue === null && enabledInRequest) {
                effectiveMap = { ...(effectiveMap ?? {}), [level]: level };
              } else if (
                baseValue !== undefined &&
                baseValue !== null &&
                !enabledInRequest &&
                (!effectiveMap || !Object.hasOwn(effectiveMap, level))
              ) {
                effectiveMap = { ...(effectiveMap ?? {}), [level]: null };
              }
            }
          }
          if (effectiveMap && Object.keys(effectiveMap).length > 0) {
            override.thinkingLevelMap = effectiveMap;
          } else {
            delete override.thinkingLevelMap;
          }
          supportedLevels = computeSupportedThinkingLevels(
            Boolean(input.reasoning),
            effectiveMap,
          );

          override.input = modalities;
          override.contextWindow = contextWindow;
          override.maxTokens = maxTokens;

          const cost = sanitizeCost(input.cost, prevOverride.cost);
          if (cost) override.cost = cost;
          else if (input.cost === undefined && prevOverride.cost) {
            override.cost = prevOverride.cost;
          } else delete override.cost;

          if (input.headers !== undefined) {
            if (headers) override.headers = headers;
            else delete override.headers;
          }

          providerEntry.modelOverrides = {
            ...(providerEntry.modelOverrides ?? {}),
            [id]: override,
          };
        } else {
          if (
            originalId &&
            originalId !== id &&
            customModels.some((item) => item.id === id)
          ) {
            throw new Error(`Model "${id}" already exists in ${providerId}`);
          }
          if (!originalId && customModels.some((item) => item.id === id)) {
            throw new Error(`Model "${id}" already exists in ${providerId}`);
          }

          const prevModel =
            existingCustomIdx >= 0 ? customModels[existingCustomIdx] : {};
          const baseModel: RawModelRecord = { ...prevModel };
          baseModel.id = id;
          if (typeof input.name === "string" && input.name.trim()) {
            baseModel.name = input.name.trim();
          } else {
            delete baseModel.name;
          }
          if (typeof input.api === "string" && input.api.trim()) {
            baseModel.api = input.api.trim();
          } else {
            delete baseModel.api;
          }
          if (typeof input.baseUrl === "string" && input.baseUrl.trim()) {
            baseModel.baseUrl = input.baseUrl.trim();
          } else {
            delete baseModel.baseUrl;
          }
          baseModel.reasoning = Boolean(input.reasoning);
          if (requestedMap) baseModel.thinkingLevelMap = requestedMap;
          else delete baseModel.thinkingLevelMap;
          baseModel.input = modalities;
          baseModel.contextWindow = contextWindow;
          baseModel.maxTokens = maxTokens;

          const cost = sanitizeCost(input.cost, prevModel.cost);
          if (cost) baseModel.cost = cost;
          else if (input.cost === undefined && prevModel.cost) {
            baseModel.cost = prevModel.cost;
          } else delete baseModel.cost;

          if (input.headers !== undefined) {
            if (headers) baseModel.headers = headers;
            else delete baseModel.headers;
          }

          if (existingCustomIdx >= 0) {
            customModels[existingCustomIdx] = baseModel;
          } else {
            customModels.push(baseModel);
          }
          providerEntry.models = customModels;
        }

        data.providers[providerId] = providerEntry;
      });

      const settings = this.settingsManager();
      if (originalId && originalId !== id) {
        settings.removeModelThinkingLevel(providerId, originalId);
        if (
          settings.getDefaultProvider() === providerId &&
          settings.getDefaultModel() === originalId
        ) {
          settings.setDefaultModelAndProvider(providerId, id);
        }
      }
      if (input.defaultThinkingLevel) {
        const level = validateThinkingLevel(input.defaultThinkingLevel);
        if (!supportedLevels.includes(level)) {
          throw new Error(
            `Thinking level "${level}" is not supported by ${id} (supported: ${supportedLevels.join(", ")})`,
          );
        }
        settings.setModelThinkingLevel(providerId, id, level);
      } else {
        settings.removeModelThinkingLevel(providerId, id);
      }
      await settings.flush();

      await this.onReload();
      return this.buildCatalog(runtime);
    });
  }

  async deleteModel(
    providerIdInput: string,
    modelIdInput: string,
  ): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      const providerId = validateProviderId(providerIdInput);
      const modelId = validateModelId(modelIdInput);
      const isBuiltin = BUILTIN_PROVIDER_IDS.has(providerId);

      const runtime = await this.commitModelsJson((data) => {
        const entry = data.providers[providerId];
        if (!entry) return;
        const copy = structuredClone(entry);
        let removedCustom = false;
        if (Array.isArray(copy.models)) {
          const next = copy.models.filter((item) => item.id !== modelId);
          removedCustom = next.length !== copy.models.length;
          if (next.length > 0) copy.models = next;
          else if (!isBuiltin) {
            const hasOtherFields =
              Boolean(copy.baseUrl) ||
              Boolean(copy.apiKey) ||
              Boolean(copy.headers) ||
              Boolean(copy.compat) ||
              copy.authHeader !== undefined;
            if (!hasOtherFields) {
              throw new Error(
                "Cannot delete the last model of a provider without a base URL",
              );
            }
            copy.models = [];
          } else {
            delete copy.models;
          }
        }
        if (!removedCustom && copy.modelOverrides?.[modelId]) {
          delete copy.modelOverrides[modelId];
          if (Object.keys(copy.modelOverrides).length === 0) {
            delete copy.modelOverrides;
          }
        }
        if (isBuiltin && Object.keys(copy).length === 0) {
          delete data.providers[providerId];
        } else {
          data.providers[providerId] = copy;
        }
      });

      const settings = this.settingsManager();
      settings.removeModelThinkingLevel(providerId, modelId);
      if (
        settings.getDefaultProvider() === providerId &&
        settings.getDefaultModel() === modelId
      ) {
        settings.setDefaultModelAndProvider(
          undefined as unknown as string,
          undefined as unknown as string,
        );
      }
      await settings.flush();

      await this.onReload();
      return this.buildCatalog(runtime);
    });
  }

  async importModels(
    providerIdInput: string,
    models: ModelUpsertInput[],
  ): Promise<ModelsCatalogResponse> {
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("Select at least one model to import");
    }
    return this.runSerialized(async () => {
      const providerId = validateProviderId(providerIdInput);
      const isBuiltin = BUILTIN_PROVIDER_IDS.has(providerId);

      const runtime = await this.commitModelsJson((data) => {
        const existingProvider = data.providers[providerId];
        if (!isBuiltin && !existingProvider) {
          throw new Error(`Provider "${providerId}" not found`);
        }
        const entry: RawProviderRecord = existingProvider
          ? structuredClone(existingProvider)
          : {};
        const list = Array.isArray(entry.models) ? [...entry.models] : [];

        for (const item of models) {
          if (!item || typeof item !== "object") {
            throw new Error("Invalid model entry");
          }
          const id = validateModelId(item.id);
          const contextWindow = Math.max(
            1,
            Math.round(Number(item.contextWindow) || 128000),
          );
          const maxTokens = Math.max(
            1,
            Math.round(Number(item.maxTokens) || 16384),
          );
          const modalities = (
            Array.isArray(item.input) && item.input.length ? item.input : ["text"]
          ).filter((m): m is ModelInputType => m === "text" || m === "image");
          const thinkingLevelMap = item.reasoning
            ? sanitizeThinkingLevelMap(item.thinkingLevelMap)
            : undefined;
          const existingIdx = list.findIndex((m) => m.id === id);
          const prevModel = existingIdx >= 0 ? list[existingIdx] : {};
          const cost = sanitizeCost(item.cost, prevModel.cost);

          if (typeof item.baseUrl === "string" && item.baseUrl.trim()) {
            normalizeHttpUrl(item.baseUrl);
          }

          const merged: RawModelRecord = {
            ...prevModel,
            id,
            reasoning: Boolean(item.reasoning),
            input: modalities.length ? modalities : ["text"],
            contextWindow,
            maxTokens,
          };
          if (typeof item.name === "string" && item.name.trim() && item.name.trim() !== id) {
            merged.name = item.name.trim();
          } else {
            delete merged.name;
          }
          if (typeof item.api === "string" && item.api.trim()) {
            merged.api = item.api.trim();
          }
          if (typeof item.baseUrl === "string" && item.baseUrl.trim()) {
            merged.baseUrl = item.baseUrl.trim();
          }
          if (thinkingLevelMap) merged.thinkingLevelMap = thinkingLevelMap;
          else delete merged.thinkingLevelMap;
          if (cost) merged.cost = cost;

          if (existingIdx >= 0) list[existingIdx] = merged;
          else list.push(merged);
        }

        entry.models = list;
        data.providers[providerId] = entry;
      });

      await this.onReload();
      return this.buildCatalog(runtime);
    });
  }

  async updateDefaults(input: ModelDefaultsInput): Promise<ModelsCatalogResponse> {
    return this.runSerialized(async () => {
      if (
        (input.defaultProvider && !input.defaultModel) ||
        (!input.defaultProvider && input.defaultModel)
      ) {
        throw new Error("Both defaultProvider and defaultModel are required");
      }

      const settings = this.settingsManager();
      if (input.defaultProvider && input.defaultModel) {
        const provider = validateProviderId(input.defaultProvider);
        const modelId = validateModelId(input.defaultModel);
        settings.setDefaultModelAndProvider(provider, modelId);
      } else {
        settings.setDefaultModelAndProvider(
          undefined as unknown as string,
          undefined as unknown as string,
        );
      }

      if (input.defaultThinkingLevel) {
        settings.setDefaultThinkingLevel(
          validateThinkingLevel(input.defaultThinkingLevel),
        );
      } else {
        settings.setDefaultThinkingLevel(undefined as unknown as ThinkingLevelOption);
      }

      await settings.flush();
      await this.onReload();
      const runtime = await this.getRuntime();
      await runtime.refresh({ allowNetwork: false });
      return this.buildCatalog(runtime);
    });
  }

  async discoverModels(
    input: DiscoverModelsInput,
  ): Promise<DiscoverModelsResponse> {
    const context = await this.runSerialized(async () => {
      const runtime = await this.getRuntime();
      await runtime.refresh({ allowNetwork: false });

      const providerId = input.providerId
        ? validateProviderId(input.providerId)
        : undefined;
      const runtimeProvider = providerId
        ? runtime.getProvider(providerId)
        : undefined;
      let rawProvider: RawProviderRecord | undefined;
      try {
        rawProvider = providerId
          ? this.readModelsJsonRaw().data.providers[providerId]
          : undefined;
      } catch {}

      const extraModels = runtime.getProviders().flatMap((p) => p.getModels());
      const configuredBaseUrlRaw =
        rawProvider?.baseUrl || runtimeProvider?.baseUrl || "";
      const baseUrlRaw = input.baseUrl?.trim() || configuredBaseUrlRaw;
      if (!baseUrlRaw) {
        throw new Error("Base URL is required to discover models");
      }
      const baseUrl = normalizeHttpUrl(baseUrlRaw);
      const cleanBase = baseUrl.toString().replace(/\/+$/, "");

      const sameOriginAsConfigured =
        !configuredBaseUrlRaw ||
        (() => {
          try {
            return normalizeHttpUrl(configuredBaseUrlRaw).origin === baseUrl.origin;
          } catch {
            return false;
          }
        })();

      const api =
        input.api?.trim() ||
        rawProvider?.api ||
        runtimeProvider?.getModels()[0]?.api ||
        "openai-completions";

      let apiKey = input.apiKey?.trim() || undefined;
      const extraHeaders: Record<string, string> = {
        ...(sameOriginAsConfigured ? sanitizeHeadersRecord(rawProvider?.headers) : undefined),
        ...sanitizeHeadersRecord(input.headers),
      };

      if (!apiKey && providerId && sameOriginAsConfigured) {
        const auth = await runtime.getAuth(providerId).catch(() => undefined);
        if (auth?.auth.apiKey && auth.auth.apiKey !== "none") {
          apiKey = auth.auth.apiKey;
        }
        if (auth?.auth.headers) {
          for (const [k, v] of Object.entries(auth.auth.headers)) {
            if (typeof v === "string" && !extraHeaders[k]) extraHeaders[k] = v;
          }
        }
      }

      const existingIds = new Set<string>(
        (runtimeProvider?.getModels() ?? []).map((m) => m.id),
      );
      for (const m of rawProvider?.models ?? []) {
        if (typeof m.id === "string") existingIds.add(m.id);
      }

      return { providerId, baseUrl, cleanBase, api, apiKey, extraHeaders, existingIds, extraModels };
    });

    const { providerId, baseUrl, cleanBase, api, apiKey, extraHeaders, existingIds, extraModels } =
      context;

    const annotate = (items: DiscoveredModel[]): DiscoveredModel[] =>
      items.map((item) => ({
        ...item,
        alreadyConfigured: existingIds.has(item.id),
      }));

    if (api === "anthropic-messages") {
      const endpoint = cleanBase.endsWith("/v1")
        ? `${cleanBase}/models`
        : `${cleanBase}/v1/models`;
      const headers: Record<string, string> = {
        "anthropic-version": "2023-06-01",
        ...extraHeaders,
      };
      if (apiKey && apiKey !== "none") headers["x-api-key"] = apiKey;
      const res = await fetchJson(endpoint, headers);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(errorDetailFromPayload(res.status, res.data));
      }
      const models = parseOpenAIOrAnthropicModels(res.data, providerId, api, undefined, extraModels);
      return { baseUrl: cleanBase, endpoint, models: annotate(models) };
    }

    if (api === "google-generative-ai") {
      const endpoint = `${cleanBase}/models`;
      const headers: Record<string, string> = { ...extraHeaders };
      if (apiKey && apiKey !== "none") headers["x-goog-api-key"] = apiKey;
      const res = await fetchJson(endpoint, headers);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(errorDetailFromPayload(res.status, res.data));
      }
      const models = parseGoogleModels(res.data, providerId, api, extraModels);
      return { baseUrl: cleanBase, endpoint, models: annotate(models) };
    }

    const authHeaders: Record<string, string> = { ...extraHeaders };
    if (
      apiKey &&
      apiKey !== "none" &&
      !authHeaders.Authorization &&
      !authHeaders.authorization
    ) {
      authHeaders.Authorization = `Bearer ${apiKey}`;
    }

    const ollamaRoot = cleanBase.endsWith("/v1")
      ? cleanBase.slice(0, -3)
      : cleanBase.endsWith("/api")
        ? cleanBase.slice(0, -4)
        : cleanBase;

    const isLikelyLmStudio =
      baseUrl.port === "1234" || /lm[-_]?studio/i.test(providerId ?? "");
    const lmStudioMeta = isLikelyLmStudio
      ? await tryFetchLmStudioMetadata(ollamaRoot, authHeaders)
      : undefined;

    const isLikelyOllama =
      baseUrl.port === "11434" ||
      /ollama/i.test(providerId ?? "") ||
      cleanBase.endsWith("/api");

    if (isLikelyOllama) {
      const ollama = await tryDiscoverOllama(ollamaRoot, authHeaders, providerId, api, extraModels);
      if (ollama) {
        return {
          baseUrl: cleanBase,
          endpoint: `${ollamaRoot}/api/tags`,
          models: annotate(ollama),
        };
      }
    }

    let endpoint = `${cleanBase}/models`;
    let res = await fetchJson(endpoint, authHeaders);
    if (res.status === 404 && !cleanBase.endsWith("/v1")) {
      endpoint = `${cleanBase}/v1/models`;
      res = await fetchJson(endpoint, authHeaders);
    }
    if (res.status < 200 || res.status >= 300) {
      const ollama = await tryDiscoverOllama(ollamaRoot, authHeaders, providerId, api, extraModels);
      if (ollama) {
        return {
          baseUrl: cleanBase,
          endpoint: `${ollamaRoot}/api/tags`,
          models: annotate(ollama),
        };
      }
      throw new Error(errorDetailFromPayload(res.status, res.data));
    }

    const models = parseOpenAIOrAnthropicModels(
      res.data,
      providerId,
      api,
      lmStudioMeta,
      extraModels,
    );
    return { baseUrl: cleanBase, endpoint, models: annotate(models) };
  }

  async inferModel(input: {
    providerId?: string;
    modelId: string;
    baseUrl?: string;
    api?: string;
  }): Promise<DiscoveredModel> {
    const providerId = input.providerId ? validateProviderId(input.providerId) : undefined;
    const modelId = validateModelId(input.modelId);
    const info = await this.runSerialized(async () => {
      const runtime = await this.getRuntime();
      await runtime.refresh({ allowNetwork: false });
      const runtimeProvider = providerId ? runtime.getProvider(providerId) : undefined;
      let rawProvider: RawProviderRecord | undefined;
      try {
        rawProvider = providerId
          ? this.readModelsJsonRaw().data.providers[providerId]
          : undefined;
      } catch {}
      const api =
        input.api?.trim() ||
        rawProvider?.api ||
        runtimeProvider?.getModels()[0]?.api ||
        "openai-completions";
      const configuredBaseUrlRaw = rawProvider?.baseUrl || runtimeProvider?.baseUrl || "";
      const baseUrlRaw = input.baseUrl?.trim() || configuredBaseUrlRaw;
      const extraModels = runtime.getProviders().flatMap((p) => p.getModels());
      let ollamaHeaders: Record<string, string> | undefined;
      let ollamaBaseUrl: string | undefined;
      if (baseUrlRaw) {
        try {
          const url = normalizeHttpUrl(baseUrlRaw);
          const sameOrigin =
            !configuredBaseUrlRaw ||
            normalizeHttpUrl(configuredBaseUrlRaw).origin === url.origin;
          const isOllama =
            url.port === "11434" ||
            /ollama/i.test(providerId ?? "") ||
            baseUrlRaw.replace(/\/+$/, "").endsWith("/api");
          if (isOllama) {
            const headers: Record<string, string> = sameOrigin
              ? { ...sanitizeHeadersRecord(rawProvider?.headers) }
              : {};
            if (providerId && sameOrigin) {
              const auth = await runtime.getAuth(providerId).catch(() => undefined);
              if (auth?.auth.apiKey && auth.auth.apiKey !== "none" && !headers.Authorization) {
                headers.Authorization = `Bearer ${auth.auth.apiKey}`;
              }
            }
            const cleanBase = url.toString().replace(/\/+$/, "");
            ollamaBaseUrl = cleanBase.endsWith("/v1")
              ? cleanBase.slice(0, -3)
              : cleanBase.endsWith("/api")
                ? cleanBase.slice(0, -4)
                : cleanBase;
            ollamaHeaders = headers;
          }
        } catch {}
      }
      return { api, baseUrlRaw, extraModels, ollamaBaseUrl, ollamaHeaders };
    });

    if (info.ollamaBaseUrl && info.ollamaHeaders) {
      try {
        const one = await tryDiscoverSingleOllamaModel(
          info.ollamaBaseUrl,
          info.ollamaHeaders,
          providerId,
          info.api,
          modelId,
          info.extraModels,
        );
        if (one) return one;
      } catch {}
    }

    if (info.baseUrlRaw) {
      try {
        const discovered = await this.discoverModels({
          providerId,
          baseUrl: info.baseUrlRaw,
          api: info.api,
        });
        const norm = modelId.toLowerCase();
        const match =
          discovered.models.find((m) => m.id === modelId) ??
          discovered.models.find((m) => m.id.toLowerCase() === norm);
        if (match) return match;
      } catch {}
    }

    return inferModelMetadata(providerId, modelId, info.api, info.extraModels);
  }
}

type LmStudioExtra = {
  name?: string;
  contextWindow?: number;
  vision?: boolean;
  reasoning?: boolean;
  reasoningLevels?: ThinkingLevelOption[];
};

function parseExplicitThinkingLevels(
  record: Record<string, unknown>,
  caps?: Record<string, unknown>,
): ThinkingLevelOption[] | undefined {
  const raw =
    record.supported_reasoning_levels ??
    record.supported_thinking_levels ??
    record.reasoning_levels ??
    record.thinking_levels ??
    record.reasoning_efforts ??
    caps?.supported_reasoning_levels ??
    caps?.supported_thinking_levels ??
    caps?.reasoning_levels ??
    caps?.thinking_levels ??
    caps?.reasoning_efforts;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<ThinkingLevelOption>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase() as ThinkingLevelOption;
    if ((THINKING_LEVELS as readonly string[]).includes(normalized)) {
      seen.add(normalized);
    }
  }
  if (seen.size === 0) return undefined;
  return THINKING_LEVELS.filter((level) => seen.has(level));
}

async function tryFetchLmStudioMetadata(
  rootBase: string,
  headers: Record<string, string>,
): Promise<Map<string, LmStudioExtra> | undefined> {
  const map = new Map<string, LmStudioExtra>();
  for (const path of ["/api/v1/models", "/api/v0/models"]) {
    try {
      const res = await fetchJson(`${rootBase}${path}`, headers);
      if (res.status < 200 || res.status >= 300 || typeof res.data !== "object" || res.data === null) {
        continue;
      }
      const list = Array.isArray((res.data as { models?: unknown }).models)
        ? (res.data as { models: unknown[] }).models
        : Array.isArray((res.data as { data?: unknown }).data)
          ? (res.data as { data: unknown[] }).data
          : [];
      for (const raw of list) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw as Record<string, unknown>;
        const id =
          (typeof item.key === "string" && item.key.trim()) ||
          (typeof item.id === "string" && item.id.trim()) ||
          "";
        if (!id) continue;
        const caps =
          typeof item.capabilities === "object" && item.capabilities !== null && !Array.isArray(item.capabilities)
            ? (item.capabilities as Record<string, unknown>)
            : undefined;
        const reasoningLevels = parseExplicitThinkingLevels(item, caps);
        const reasoningFlag =
          reasoningLevels !== undefined
            ? reasoningLevels.some((lvl) => lvl !== "off")
            : typeof item.reasoning === "boolean"
              ? item.reasoning
              : typeof caps?.reasoning === "boolean"
                ? caps.reasoning
                : typeof caps?.thinking === "boolean"
                  ? caps.thinking
                  : undefined;
        map.set(id, {
          name:
            typeof item.display_name === "string" && item.display_name.trim()
              ? item.display_name.trim()
              : undefined,
          contextWindow:
            positiveNumber(item.max_context_length) ??
            positiveNumber(item.loaded_context_length),
          vision: item.type === "vlm" || caps?.vision === true,
          ...(reasoningFlag !== undefined ? { reasoning: reasoningFlag } : {}),
          ...(reasoningLevels !== undefined ? { reasoningLevels } : {}),
        });
      }
      if (map.size > 0) return map;
    } catch {}
  }
  return map.size > 0 ? map : undefined;
}

function parseOpenAIOrAnthropicModels(
  payload: unknown,
  providerId: string | undefined,
  api: string,
  extraMeta?: Map<string, LmStudioExtra>,
  extraModels?: readonly Model<Api>[],
): DiscoveredModel[] {
  const rawList: unknown[] = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : Array.isArray((payload as { models?: unknown }).models)
          ? (payload as { models: unknown[] }).models
          : []
      : [];

  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const entry of rawList) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const inferred = inferModelMetadata(providerId, id, api, extraModels);
    const lmExtra = extraMeta?.get(id);
    const displayName =
      lmExtra?.name ||
      (typeof item.display_name === "string" && item.display_name.trim()) ||
      (typeof item.name === "string" && item.name.trim()) ||
      inferred.name ||
      id;

    const contextWindow =
      positiveNumber(item.context_length) ??
      positiveNumber(item.max_model_len) ??
      positiveNumber(item.context_window) ??
      positiveNumber(item.input_token_limit) ??
      positiveNumber(item.max_input_tokens) ??
      positiveNumber(item.max_context_length) ??
      positiveNumber(item.loaded_context_length) ??
      lmExtra?.contextWindow ??
      inferred.contextWindow;

    const topProvider =
      typeof item.top_provider === "object" && item.top_provider !== null
        ? (item.top_provider as Record<string, unknown>)
        : undefined;
    const maxTokens =
      positiveNumber(topProvider?.max_completion_tokens) ??
      positiveNumber(item.max_completion_tokens) ??
      positiveNumber(item.max_output_tokens) ??
      positiveNumber(item.max_tokens) ??
      positiveNumber(item.output_token_limit) ??
      inferred.maxTokens;

    const supportedParams = Array.isArray(item.supported_parameters)
      ? item.supported_parameters.filter((v): v is string => typeof v === "string")
      : undefined;
    const capabilities =
      typeof item.capabilities === "object" && item.capabilities !== null
        ? (item.capabilities as Record<string, unknown>)
        : undefined;
    const capThinking =
      typeof capabilities?.thinking === "object" && capabilities.thinking !== null
        ? (capabilities.thinking as { supported?: unknown }).supported
        : capabilities?.thinking;
    const capImageInput =
      typeof capabilities?.image_input === "object" && capabilities.image_input !== null
        ? (capabilities.image_input as { supported?: unknown }).supported
        : undefined;

    let reasoning = inferred.reasoning;
    let reasoningSource: ReasoningSource = inferred.reasoningSource;
    let thinkingLevelMap = reasoning ? inferred.thinkingLevelMap : undefined;

    const explicitLevels =
      parseExplicitThinkingLevels(item, capabilities) ?? lmExtra?.reasoningLevels;
    if (explicitLevels) {
      reasoning = explicitLevels.some((lvl) => lvl !== "off");
      reasoningSource = "provider-api";
      thinkingLevelMap = reasoning ? levelsToThinkingLevelMap(explicitLevels) : undefined;
    } else if (
      lmExtra?.reasoning === true ||
      supportedParams?.includes("reasoning") ||
      supportedParams?.includes("include_reasoning") ||
      supportedParams?.includes("reasoning_effort") ||
      capabilities?.reasoning === true ||
      capThinking === true ||
      item.reasoning === true ||
      item.thinking === true ||
      item.supports_reasoning === true
    ) {
      reasoning = true;
      reasoningSource = "provider-api";
      thinkingLevelMap = inferred.thinkingLevelMap;
    } else if (
      lmExtra?.reasoning === false ||
      capabilities?.reasoning === false ||
      capThinking === false ||
      item.reasoning === false ||
      item.thinking === false ||
      item.supports_reasoning === false ||
      (supportedParams &&
        supportedParams.length > 0 &&
        !supportedParams.includes("reasoning") &&
        !supportedParams.includes("include_reasoning") &&
        !supportedParams.includes("reasoning_effort"))
    ) {
      reasoning = false;
      reasoningSource = "provider-api";
      thinkingLevelMap = undefined;
    }

    const architecture =
      typeof item.architecture === "object" && item.architecture !== null
        ? (item.architecture as Record<string, unknown>)
        : undefined;
    const rawModalities = Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities
      : Array.isArray(item.input_modalities)
        ? item.input_modalities
        : undefined;
    let input: ModelInputType[] = inferred.input;
    if (rawModalities) {
      const parsedMods: ModelInputType[] = ["text"];
      if (rawModalities.includes("image")) parsedMods.push("image");
      input = parsedMods;
    } else if (
      (capabilities?.vision === true || capImageInput === true || lmExtra?.vision === true) &&
      !input.includes("image")
    ) {
      input = ["text", "image"];
    }

    const pricing =
      typeof item.pricing === "object" && item.pricing !== null
        ? (item.pricing as Record<string, unknown>)
        : undefined;
    let cost = inferred.cost;
    if (pricing && (pricing.prompt !== undefined || pricing.completion !== undefined)) {
      const promptPerTok = Number(pricing.prompt);
      const completionPerTok = Number(pricing.completion);
      const cacheReadPerTok = Number(pricing.input_cache_read ?? 0);
      const cacheWritePerTok = Number(pricing.input_cache_write ?? 0);
      if (Number.isFinite(promptPerTok) && Number.isFinite(completionPerTok)) {
        cost = {
          input: roundPrice(Math.max(0, promptPerTok) * 1_000_000),
          output: roundPrice(Math.max(0, completionPerTok) * 1_000_000),
          cacheRead: Number.isFinite(cacheReadPerTok)
            ? roundPrice(Math.max(0, cacheReadPerTok) * 1_000_000)
            : 0,
          cacheWrite: Number.isFinite(cacheWritePerTok)
            ? roundPrice(Math.max(0, cacheWritePerTok) * 1_000_000)
            : 0,
        };
      }
    }

    const resultItem: DiscoveredModel = {
      id,
      name: displayName,
      api,
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
      supportedThinkingLevels: computeSupportedThinkingLevels(
        reasoning,
        reasoning ? thinkingLevelMap : undefined,
      ),
      input,
      contextWindow,
      maxTokens,
      cost,
      reasoningSource,
      alreadyConfigured: false,
    };
    result.push(resultItem);
  }

  return result;
}

function parseGoogleModels(
  payload: unknown,
  providerId: string | undefined,
  api: string,
  extraModels?: readonly Model<Api>[],
): DiscoveredModel[] {
  const models =
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : [];
  const result: DiscoveredModel[] = [];

  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods
      : undefined;
    if (methods && !methods.includes("generateContent")) continue;

    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    const id = rawName.replace(/^models\//, "");
    if (!id) continue;

    const inferred = inferModelMetadata(providerId ?? "google", id, api, extraModels);
    const displayName =
      typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : inferred.name;
    const contextWindow =
      positiveNumber(item.inputTokenLimit) ?? inferred.contextWindow;
    const maxTokens =
      positiveNumber(item.outputTokenLimit) ?? inferred.maxTokens;
    const explicitLevels = parseExplicitThinkingLevels(item);
    const reasoning = explicitLevels
      ? explicitLevels.some((lvl) => lvl !== "off")
      : typeof item.thinking === "boolean"
        ? item.thinking
        : inferred.reasoning;
    const reasoningSource: ReasoningSource =
      explicitLevels || typeof item.thinking === "boolean"
        ? "provider-api"
        : inferred.reasoningSource;

    const thinkingLevelMap = explicitLevels
      ? reasoning
        ? levelsToThinkingLevelMap(explicitLevels)
        : undefined
      : reasoning
        ? inferred.thinkingLevelMap
        : undefined;
    result.push({
      id,
      name: displayName,
      api,
      reasoning,
      thinkingLevelMap,
      supportedThinkingLevels: computeSupportedThinkingLevels(
        reasoning,
        thinkingLevelMap,
      ),
      input: inferred.input,
      contextWindow,
      maxTokens,
      cost: inferred.cost,
      reasoningSource,
      alreadyConfigured: false,
    });
  }

  return result;
}

async function fetchOllamaShowDetails(
  rootBase: string,
  headers: Record<string, string>,
  providerId: string | undefined,
  api: string,
  id: string,
  extraModels?: readonly Model<Api>[],
): Promise<{ found: boolean; model: DiscoveredModel }> {
  const inferred = inferModelMetadata(providerId, id, api, extraModels);
  let reasoning = inferred.reasoning;
  let reasoningSource: ReasoningSource = inferred.reasoningSource;
  let contextWindow = inferred.contextWindow;
  let input = inferred.input;
  let found = false;

  try {
    const show = await fetchJson(
      `${rootBase}/api/show`,
      headers,
      "POST",
      { name: id },
    );
    if (
      show.status >= 200 &&
      show.status < 300 &&
      typeof show.data === "object" &&
      show.data !== null
    ) {
      found = true;
      const detail = show.data as Record<string, unknown>;
      if (Array.isArray(detail.capabilities)) {
        const caps = detail.capabilities;
        reasoning = caps.includes("thinking");
        reasoningSource = "provider-api";
        input = caps.includes("vision") ? ["text", "image"] : ["text"];
      } else if (typeof detail.template === "string" && /<think>|enable_thinking/i.test(detail.template)) {
        reasoning = true;
        reasoningSource = "provider-api";
      }
      if (typeof detail.model_info === "object" && detail.model_info !== null) {
        for (const [key, val] of Object.entries(
          detail.model_info as Record<string, unknown>,
        )) {
          if (key.endsWith(".context_length") && typeof val === "number" && val > 0) {
            contextWindow = val;
            break;
          }
        }
      }
    }
  } catch {}

  const thinkingLevelMap = reasoning ? inferred.thinkingLevelMap : undefined;
  return {
    found,
    model: {
      id,
      name: id,
      api,
      reasoning,
      thinkingLevelMap,
      supportedThinkingLevels: computeSupportedThinkingLevels(
        reasoning,
        thinkingLevelMap,
      ),
      input,
      contextWindow,
      maxTokens: inferred.maxTokens,
      reasoningSource,
      alreadyConfigured: false,
    },
  };
}

async function tryDiscoverSingleOllamaModel(
  rootBase: string,
  headers: Record<string, string>,
  providerId: string | undefined,
  api: string,
  id: string,
  extraModels?: readonly Model<Api>[],
): Promise<DiscoveredModel | undefined> {
  const res = await fetchOllamaShowDetails(rootBase, headers, providerId, api, id, extraModels);
  return res.found ? res.model : undefined;
}

async function tryDiscoverOllama(
  rootBase: string,
  headers: Record<string, string>,
  providerId: string | undefined,
  api: string,
  extraModels?: readonly Model<Api>[],
): Promise<DiscoveredModel[] | undefined> {
  let tagsRes: { status: number; data: unknown };
  try {
    tagsRes = await fetchJson(`${rootBase}/api/tags`, headers);
  } catch {
    return undefined;
  }
  if (tagsRes.status < 200 || tagsRes.status >= 300) return undefined;
  const rawModels =
    typeof tagsRes.data === "object" &&
    tagsRes.data !== null &&
    Array.isArray((tagsRes.data as { models?: unknown }).models)
      ? (tagsRes.data as { models: unknown[] }).models
      : undefined;
  if (!rawModels) return undefined;

  const ids = rawModels
    .map((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === "string"
        ? (entry as { name: string }).name.trim()
        : "",
    )
    .filter(Boolean);

  const models: DiscoveredModel[] = new Array(ids.length);
  const concurrency = 5;
  let cursor = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      const id = ids[index];
      if (index < 30) {
        const { model } = await fetchOllamaShowDetails(
          rootBase,
          headers,
          providerId,
          api,
          id,
          extraModels,
        );
        models[index] = model;
      } else {
        models[index] = inferModelMetadata(providerId, id, api, extraModels);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, ids.length)) }, () =>
      worker(),
    ),
  );
  return models;
}

function positiveNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : undefined;
}

function roundPrice(value: number): number {
  return Math.round(value * 10000) / 10000;
}
