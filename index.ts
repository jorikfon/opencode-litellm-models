import type { Plugin } from "@opencode-ai/plugin"

/** Один элемент ответа LiteLLM `GET /model_group/info`. Всё, кроме имени, может быть null. */
export type LiteLLMGroup = {
  model_group: string
  mode?: string | null
  max_input_tokens?: number | null
  max_output_tokens?: number | null
  input_cost_per_token?: number | null
  output_cost_per_token?: number | null
  supports_vision?: boolean | null
  supports_function_calling?: boolean | null
  supports_reasoning?: boolean | null
  supported_reasoning_efforts?: string[] | null
}

export type MapOptions = {
  /** Чем заполнять лимиты у моделей, по которым LiteLLM их не отдаёт. */
  defaultContext?: number
  defaultOutput?: number
}

/** Режимы, которые в списке моделей чата не нужны. */
const SKIP_MODES = new Set([
  "embedding",
  "rerank",
  "moderation",
  "moderations",
  "image_generation",
  "audio_transcription",
  "audio_speech",
])

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 8_192

/** LiteLLM отдаёт цену за токен, opencode ждёт за миллион. */
const perMillion = (v: number | null | undefined) => (typeof v === "number" ? v * 1e6 : 0)

const toInt = (v: number | null | undefined, fallback: number) =>
  typeof v === "number" && v > 0 ? Math.floor(v) : fallback

export function isChatGroup(group: LiteLLMGroup): boolean {
  // mode у части рабочих моделей null — это не повод их прятать, отсекаем только явно не-чатовые.
  return !SKIP_MODES.has(String(group.mode ?? "").toLowerCase())
}

/** Модель в формате `provider.<id>.models.<id>` конфига opencode. */
export function toModel(group: LiteLLMGroup, opts: MapOptions = {}): Record<string, unknown> {
  const vision = group.supports_vision === true
  return {
    name: group.model_group,
    attachment: vision,
    reasoning: group.supports_reasoning === true,
    temperature: true,
    tool_call: group.supports_function_calling !== false,
    cost: {
      input: perMillion(group.input_cost_per_token),
      output: perMillion(group.output_cost_per_token),
    },
    limit: {
      context: toInt(group.max_input_tokens, opts.defaultContext ?? DEFAULT_CONTEXT),
      output: toInt(group.max_output_tokens, opts.defaultOutput ?? DEFAULT_OUTPUT),
    },
    modalities: {
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    status: "active",
  }
}

export function toModels(groups: LiteLLMGroup[], opts: MapOptions = {}): Record<string, unknown> {
  return Object.fromEntries(
    groups.filter(isChatGroup).map((group) => [group.model_group, toModel(group, opts)]),
  )
}

/** Уровни reasoning, объявленные LiteLLM, по id модели. Пустых списков не держим. */
export function effortsByModel(groups: LiteLLMGroup[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const group of groups) {
    const efforts = group.supported_reasoning_efforts ?? []
    if (efforts.length > 0) out.set(group.model_group, efforts)
  }
  return out
}

/**
 * Меню уровней в opencode фиксированное (low/medium/high/max) и из конфига не меняется,
 * а непринятый уровень — это 400 у провайдера, cooldown деплоймента и 429 всем остальным.
 * Поэтому уровень вне объявленного набора не отправляем вовсе: пусть решает модель.
 */
export function allowedEffort(
  efforts: string[] | undefined,
  requested: unknown,
): string | undefined {
  if (typeof requested !== "string") return undefined
  if (!efforts || efforts.length === 0) return requested
  return efforts.includes(requested) ? requested : undefined
}

/** `https://host/v1` → `https://host`: model_group/info живёт в корне прокси. */
export function proxyRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")
}

export async function fetchGroups(baseURL: string, apiKey?: string): Promise<LiteLLMGroup[]> {
  const res = await fetch(`${proxyRoot(baseURL)}/model_group/info`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  if (!res.ok) {
    // Тело ответа LiteLLM отличает «ключ не передан» от «ключ не найден в базе»,
    // а сам ключ в нём уже маскирован — без этого 401 не диагностируется.
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300)
    throw new Error(`model_group/info: HTTP ${res.status}${detail ? ` ${detail}` : ""}`)
  }
  const body = (await res.json()) as { data?: LiteLLMGroup[] }
  return body.data ?? []
}

export const LitellmModels: Plugin = async (_input, options = {}) => {
  const providerID = typeof options.provider === "string" ? options.provider : "litellm"
  let efforts = new Map<string, string[]>()

  return {
    async config(config) {
      const provider = (config.provider ?? {})[providerID] as
        | { options?: Record<string, any>; models?: Record<string, unknown> }
        | undefined
      if (!provider) return

      const baseURL =
        (typeof options.baseURL === "string" ? options.baseURL : undefined) ||
        provider.options?.baseURL ||
        process.env.LITELLM_BASE_URL
      if (!baseURL) return
      // Нераскрытый `{env:...}` доходит сюда как пустая строка (либо undefined),
      // поэтому `||`: иначе пустое значение из конфига перекрывает переменную окружения.
      const apiKey = provider.options?.apiKey || process.env.LITELLM_API_KEY

      try {
        const groups = await fetchGroups(baseURL, apiKey)
        efforts = effortsByModel(groups)
        const discovered = toModels(groups, {
          defaultContext: typeof options.defaultContext === "number" ? options.defaultContext : undefined,
          defaultOutput: typeof options.defaultOutput === "number" ? options.defaultOutput : undefined,
        })
        // Прописанное руками в opencode.json выигрывает у найденного.
        provider.models = { ...discovered, ...(provider.models ?? {}) }
      } catch (err) {
        // Провайдер без моделей не поднимется вовсе — при любой беде оставляем конфиг как есть.
        // Молчать нельзя: снаружи это выглядит как «Provider not found», причина не видна.
        console.warn(`[litellm] ${providerID}: could not read the model list (${err}); leaving the config as it is`)
      }
    },

    async "chat.params"(input, output) {
      if (input.model.providerID !== providerID || !output.options) return
      const known = efforts.get(input.model.id) ?? efforts.get(input.model.api?.id as string)
      const allowed = allowedEffort(known, output.options.reasoningEffort)
      if (allowed === undefined) delete output.options.reasoningEffort
      else output.options.reasoningEffort = allowed
    },
  }
}
