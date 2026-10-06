/**
 * Cloudflare Workers AI models bound to the native `env.AI` binding.
 *
 * All inference goes through the AI binding — no API token, no account-id
 * catalog fetch, no AI Gateway, no external provider. The transport bridge
 * converts the OpenAI-compatible chat-completions request that Pi's
 * `openai-completions` API assembles into a native `env.AI.run()` call and
 * hands the raw upstream Response back, so Pi's existing OpenAI wire decoder
 * (text deltas, tool-call id/name/arguments, `reasoning_content`, finish
 * reasons, usage) does all protocol work. Nothing SSE-related is hand-rolled
 * here.
 *
 * Why `Ai.run` and not `Ai.fetch`/`createAiBindingFetch`: Pi's binding-fetch
 * passthrough serves routes that exist under the runtime's internal
 * `workers-binding.ai` host — the gateway passthrough (`/ai-gateway/...`),
 * `/run` and `/ai-api/models/search` (workerd `src/cloudflare/internal/ai-api.ts`).
 * There is no documented native Workers AI `/v1/chat/completions` route on
 * that host, and the gateway passthrough would require a gateway id. The
 * documented native path is `env.AI.run(model, inputs)`; for the OpenAI-schema
 * chat models the run inputs are exactly the OpenAI chat-completions body
 * (messages, stream, stream_options, tools, tool_choice, reasoning_effort,
 * max_completion_tokens — verified against the
 * `@cf/deepseek-ai/deepseek-v4-flash-0731` model docs and a live smoke run).
 *
 * Live native-binding smoke and protected full-application coding turns
 * exercised the raw Response path, including decoded tool calls and usage.
 * Static registry tests alone do not cover the full deployed module graph.
 *
 * Browser/Workers-safe: imports only the lazy OpenAI-completions API plus
 * type-level Pi modules; `createModels` gets an inert auth context so no
 * ambient env/file/catalog initialization can run.
 */
// Runtime factory imports must use the public `./models` subpath, never the root
// barrel. `@earendil-works/pi-ai` marks dist/models.js side-effect-free, and the
// bundled app reaches models.js only through the dynamically imported
// openai-completions.js, so esbuild wraps models.js in a lazy `__esm` init:
// `createModels`/`createProvider` are hoisted out as pure functions while
// `ModelsImpl` stays assigned inside an init that runs only on the first stream's
// dynamic import. DO init then executes `new ModelsImpl` before any of that —
// "ModelsImpl is not a constructor". A static subpath import makes models.js a
// statically reachable module, so its init runs eagerly at worker boot.
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
// Type-only barrel imports are erased at runtime (verbatimModuleSyntax) and carry
// no initialization semantics; several of these names are not re-exported by the
// `./models` subpath.
import type {
  FetchFunction,
  Model,
  ModelCost,
  Models,
  OpenAICompletionsCompat,
  Provider,
  ProviderStreams,
  StreamOptions,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelRef } from "@earendil-works/pi-durable";

/** Registered provider id — ModelRef.provider always matches this. */
export const WORKERS_AI_PROVIDER_ID = "cloudflare-workers-ai-binding";

/** Placeholder request base. The transport bridge never fetches; Pi's OpenAI client only needs a syntactic base URL. */
const BINDING_BASE_URL = "https://workers-binding.ai/ai/v1";

/**
 * Sentinel request credential. Binding calls are pre-authenticated in-account,
 * so no real token exists; the OpenAI client requires a non-empty api key
 * before dispatch, and the bridge discards all request headers.
 */
const BINDING_SENTINEL_API_KEY = "workers-ai-binding";

/** Documented default model (Cloudflare Workers AI, function calling + reasoning, 1,048,576-token context). */
export const DEFAULT_WORKERS_AI_MODEL_ID = "@cf/deepseek-ai/deepseek-v4-flash-0731";

/** Explicit model metadata, overridable per model id. Prices are $/million tokens. */
export interface WorkersAiModelMetadata {
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: ThinkingLevelMap;
  cost: ModelCost;
}

/**
 * Metadata for the default model, from its Cloudflare model page: context
 * 1,048,576; reasoning levels none/low/high/max (aliases minimal→low,
 * medium→high, xhigh→high); $0.44/M input, $1.32/M output, $0.014/M cached
 * input. Output is bounded to 8,192 tokens here — the app's generation cap,
 * deliberately not the context window.
 */
export const DEFAULT_WORKERS_AI_MODEL_METADATA: WorkersAiModelMetadata = {
  name: "DeepSeek V4 Flash 0731",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 8192,
  thinkingLevelMap: {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
    xhigh: "high",
    max: "max",
  },
  cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
};

/**
 * Compatibility profile for the Workers AI OpenAI-compatible wire, pinned
 * explicitly so behavior does not drift with base-URL auto-detection. Matches
 * the model docs: OpenAI chat-completions schema, `reasoning_effort`
 * (none/low/high/max), `max_completion_tokens`, usage in streaming, native
 * finish reasons. DeepSeek-style reasoning replay is enabled because the
 * served model is DeepSeek-family; Pi then replays an empty
 * `reasoning_content` on assistant turns — UNTESTED ASSUMPTION for models
 * whose upstream template does not expect that field; if the live smoke shows
 * the endpoint rejecting it, override via model `compat`/metadata rather than
 * editing this file ad hoc.
 */
const WORKERS_AI_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "openai",
  zaiToolStream: false,
  supportsThinkingTokenBudget: false,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false,
  supportsMidConvoToolAdditions: false,
  // Prefix caching: Pi Durable passes each conversation's persisted provider session id, and
  // `openai-nosession` turns it into `x-session-affinity` (plus `x-client-request-id`, which the
  // bridge drops). Workers AI routes requests with the same affinity id to the same model
  // instance, where the conversation's cached prefix lives.
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: "openai-nosession",
  supportsLongCacheRetention: false,
};

/** The only request header the bridge forwards to the binding (as `extraHeaders`). */
const SESSION_AFFINITY_HEADER = "x-session-affinity";

/**
 * Bridge `fetch` → `env.AI.run`. Receives the OpenAI client's request
 * (method/body/signal), extracts the chat-completions JSON body — which for
 * OpenAI-schema models is exactly the run-input shape — and returns the raw
 * upstream Response. Headers are dropped by design (binding calls carry no
 * credentials), except `x-session-affinity`, which is forwarded through the
 * binding's documented `extraHeaders` option so Workers AI prefix caching can
 * route the conversation to the instance holding its cached prompt. The model
 * id comes from the request body (Pi always sets it to the registered model
 * id); `fallbackModelId` covers a body without one.
 *
 * `ai.run` is invoked as a real method so `this` stays bound to the binding.
 * The generated `Ai` type narrows inputs to per-model schema unions and keys
 * `run` on its model catalog, while this bridge accepts any `@cf/...` id and
 * forwards the OpenAI chat-completions body verbatim — so the result is
 * asserted to the raw-response promise that `returnRawResponse: true` yields
 * at runtime (workerd `ai-api.ts`).
 */
function createBindingRunFetch(ai: Ai, fallbackModelId: string): FetchFunction {
  if (typeof ai.run !== "function") {
    throw new TypeError(
      "createWorkersAiModels: the value passed as the AI binding does not expose run()",
    );
  }
  return async (input, init) => {
    let body: unknown;
    let signal: AbortSignal | undefined = init?.signal ?? undefined;
    let affinity = new Headers(init?.headers).get(SESSION_AFFINITY_HEADER);
    if (typeof input === "object" && input !== null && !(input instanceof URL)) {
      const request = input as Request;
      body = await request.json();
      signal ??= request.signal ?? undefined;
      affinity ??= request.headers.get(SESSION_AFFINITY_HEADER);
    } else {
      const rawBody = init?.body;
      if (typeof rawBody !== "string") {
        throw new TypeError("Workers AI transport bridge: expected a JSON string request body");
      }
      body = JSON.parse(rawBody);
    }
    const params = body as Record<string, unknown>;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new TypeError("Workers AI transport bridge: request body is not a JSON object");
    }
    const modelId =
      typeof params.model === "string" && params.model.length > 0 ? params.model : fallbackModelId;
    const options: AiOptions & { returnRawResponse: true } = { returnRawResponse: true };
    if (signal !== undefined) options.signal = signal;
    if (affinity !== null && affinity.length > 0) {
      options.extraHeaders = { [SESSION_AFFINITY_HEADER]: affinity };
    }
    return ai.run(modelId, params, options) as unknown as Promise<Response>;
  };
}

/**
 * Bind the transport at provider level: every stream dispatched by this
 * provider goes through the binding bridge with the sentinel credential,
 * regardless of what per-call options the caller passes. Callers cannot
 * accidentally bypass the binding, and the harness never has to remember
 * per-call `fetch` options.
 */
function withBindingTransport(
  streams: ProviderStreams,
  bindingFetch: FetchFunction,
): ProviderStreams {
  const transport = (options?: StreamOptions): StreamOptions => ({
    ...options,
    apiKey: options?.apiKey ?? BINDING_SENTINEL_API_KEY,
    fetch: bindingFetch,
  });
  return {
    stream: (model, context, options) => streams.stream(model, context, transport(options)),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, transport(options)),
  };
}

/**
 * Keyless auth: the provider is always configured because the credential is
 * the binding itself. Resolution is side-effect-free and touches no ambient
 * env — it exists so Pi's auth pipeline marks the provider available and
 * satisfies the OpenAI client's api-key requirement.
 */
const bindingAuth = {
  apiKey: {
    name: "Workers AI binding",
    resolve: async () => ({
      auth: { apiKey: BINDING_SENTINEL_API_KEY },
      source: "Workers AI binding (pre-authenticated)",
    }),
  },
};

/**
 * Build a `Models` collection with a Workers AI provider whose sole chat model
 * runs through the `env.AI` binding.
 *
 * @param ai the Workers AI binding (`env.AI`).
 * @param modelId Workers AI model id; defaults to
 *   `@cf/deepseek-ai/deepseek-v4-flash-0731`. Any `@cf/...` id is accepted.
 * @param metadata explicit model metadata. The defaults describe the default
 *   model only — for any other model id, pass metadata (at minimum
 *   `contextWindow`, `maxTokens`, `reasoning`) rather than trusting defaults
 *   that do not fit.
 * @returns `models`: a `Models` with the provider registered under
 *   `WORKERS_AI_PROVIDER_ID`; `model`: a `ModelRef` into that collection
 *   (`provider` matches the registered provider id).
 */
export function createWorkersAiModels(
  ai: Ai,
  modelId: string = DEFAULT_WORKERS_AI_MODEL_ID,
  metadata?: Partial<WorkersAiModelMetadata>,
): { models: Models; model: ModelRef } {
  const resolved: WorkersAiModelMetadata = { ...DEFAULT_WORKERS_AI_MODEL_METADATA, ...metadata };
  const bindingFetch = createBindingRunFetch(ai, modelId);

  const model: Model<"openai-completions"> = {
    id: modelId,
    name: resolved.name,
    api: "openai-completions",
    provider: WORKERS_AI_PROVIDER_ID,
    baseUrl: BINDING_BASE_URL,
    input: ["text"],
    reasoning: resolved.reasoning,
    thinkingLevelMap: resolved.thinkingLevelMap,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    compat: WORKERS_AI_COMPAT,
    cost: resolved.cost,
  };

  // Provider-level transport binding: the wrapped streams own the bridge.
  const provider: Provider<"openai-completions"> = createProvider<"openai-completions">({
    id: WORKERS_AI_PROVIDER_ID,
    name: "Cloudflare Workers AI (binding)",
    auth: bindingAuth,
    models: [model],
    api: withBindingTransport(openAICompletionsApi(), bindingFetch),
  });

  // Inert auth context: no ambient env reads, no file checks, no catalog
  // network — this collection is bound to exactly one provider.
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(provider);

  return { models, model: { provider: WORKERS_AI_PROVIDER_ID, modelId } };
}
