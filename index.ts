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

/**
 * Один деплоймент из `GET /model/info`. Из `litellm_params` читаем только reasoning-поля:
 * остальное там — ссылки на ключи провайдеров, его не логируем и не храним.
 */
export type LiteLLMDeployment = {
  model_name: string
  litellm_params?: {
    reasoning_effort?: unknown
    enable_thinking?: unknown
    thinking?: { type?: unknown } | null
  } | null
  model_info?: {
    cache_read_input_token_cost?: number | null
    cache_creation_input_token_cost?: number | null
  } | null
}

export type KeyModel = { cache_read: number; cache_write: number; noReasoning: boolean }

/** Reasoning выключен на самом деплойменте — уровни от клиента он всё равно не примет. */
export function reasoningPinnedOff(d: LiteLLMDeployment): boolean {
  const p = d.litellm_params ?? {}
  return p.reasoning_effort === "none" || p.enable_thinking === false || p.thinking?.type === "disabled"
}

/**
 * Модели, доступные ключу, с ценой кэша и признаком выключенного reasoning.
 * Цена — от первого деплоймента имени; reasoning выключен, только если выключен у всех.
 * ponytail: при нескольких деплойментах с разной ценой берётся первая, не максимум.
 */
export function keyModels(deployments: LiteLLMDeployment[]): Map<string, KeyModel> {
  const out = new Map<string, KeyModel>()
  for (const d of deployments) {
    const seen = out.get(d.model_name)
    if (seen) {
      seen.noReasoning &&= reasoningPinnedOff(d)
      continue
    }
    out.set(d.model_name, {
      cache_read: perMillion(d.model_info?.cache_read_input_token_cost),
      cache_write: perMillion(d.model_info?.cache_creation_input_token_cost),
      noReasoning: reasoningPinnedOff(d),
    })
  }
  return out
}

/** Уровни, которые opencode сам может предложить в меню (варианты модели). */
const OPENCODE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Меню уровней opencode под объявленный LiteLLM набор: чужие уровни выключаем (`disabled`),
 * недостающие добавляем с тем же `reasoningEffort`. `none` в меню не нужен — это модель без уровня.
 * Без объявленного набора меню не трогаем.
 */
export function variants(efforts: string[] | null | undefined): Record<string, Record<string, unknown>> | undefined {
  if (!efforts || efforts.length === 0) return undefined
  const out: Record<string, Record<string, unknown>> = {}
  for (const level of OPENCODE_LEVELS) if (!efforts.includes(level)) out[level] = { disabled: true }
  for (const effort of efforts) if (effort !== "none") out[effort] = { reasoningEffort: effort }
  return out
}

/** Модель в формате `provider.<id>.models.<id>` конфига opencode. */
export function toModel(group: LiteLLMGroup, opts: MapOptions = {}, cache?: KeyModel): Record<string, unknown> {
  const vision = group.supports_vision === true
  // У `*-no-reasoning` LiteLLM объявляет supports_reasoning, но деплоймент его выключает: меню уровней не нужно.
  const reasoning = group.supports_reasoning === true && !cache?.noReasoning
  const menu = reasoning ? variants(group.supported_reasoning_efforts) : undefined
  return {
    name: group.model_group,
    attachment: vision,
    reasoning,
    ...(menu ? { variants: menu } : {}),
    temperature: true,
    tool_call: group.supports_function_calling !== false,
    cost: {
      input: perMillion(group.input_cost_per_token),
      output: perMillion(group.output_cost_per_token),
      cache_read: cache?.cache_read ?? 0,
      cache_write: cache?.cache_write ?? 0,
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

/** Чат-группы, которые ключ может вызвать. Без списка ключа (`undefined`) — все чат-группы. */
export function toModels(
  groups: LiteLLMGroup[],
  opts: MapOptions = {},
  allowed?: Map<string, KeyModel>,
): Record<string, unknown> {
  return Object.fromEntries(
    groups
      .filter((group) => isChatGroup(group) && (!allowed || allowed.has(group.model_group)))
      .map((group) => [group.model_group, toModel(group, opts, allowed?.get(group.model_group))]),
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

/**
 * `/model_group/info` отдаёт все публичные группы, в том числе чужие для ключа (запрос к ним — 403),
 * а `/model/info` — только деплойменты, доступные ключу, но без уровней reasoning. Берём пересечение.
 * Если `/model/info` не отвечает или пуст — фильтра нет, как раньше.
 */
export async function fetchKeyModels(baseURL: string, apiKey?: string): Promise<Map<string, KeyModel> | undefined> {
  try {
    const res = await fetch(`${proxyRoot(baseURL)}/model/info`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { data?: LiteLLMDeployment[] }
    const models = keyModels(body.data ?? [])
    if (models.size > 0) return models
    throw new Error("empty list")
  } catch (err) {
    console.warn(`[litellm] model/info: ${err}; showing every model group, some may answer 403`)
    return undefined
  }
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
        const [groups, allowed] = await Promise.all([fetchGroups(baseURL, apiKey), fetchKeyModels(baseURL, apiKey)])
        efforts = effortsByModel(groups)
        const discovered = toModels(groups, {
          defaultContext: typeof options.defaultContext === "number" ? options.defaultContext : undefined,
          defaultOutput: typeof options.defaultOutput === "number" ? options.defaultOutput : undefined,
        }, allowed)
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
