import { test } from "node:test"
import assert from "node:assert/strict"
import { allowedEffort, effortsByModel, fetchGroups, isChatGroup, keyModels, proxyRoot, variants, toModel, toModels, type LiteLLMGroup } from "../index.ts"

// Срез живого ответа LiteLLM /model_group/info, вместе с грязью:
// mode=null у рабочей чат-модели, лимиты null, эмбеддинги в общем списке.
const groups: LiteLLMGroup[] = [
  {
    model_group: "deepseek-v4-flash",
    mode: "chat",
    max_input_tokens: 1000000.0,
    max_output_tokens: 393216.0,
    input_cost_per_token: 3e-7,
    output_cost_per_token: 1.2e-6,
    supports_vision: true,
    supports_function_calling: true,
    supports_reasoning: true,
    supported_reasoning_efforts: ["none", "low", "high", "max"],
  },
  { model_group: "qwen3.8-max", mode: null, max_input_tokens: null, max_output_tokens: null },
  { model_group: "ollama/bge-m3", mode: "embedding" },
]

test("эмбеддинги отсеиваются, модель с mode=null остаётся", () => {
  const models = toModels(groups)
  assert.deepEqual(Object.keys(models).sort(), ["deepseek-v4-flash", "qwen3.8-max"])
  assert.equal(isChatGroup({ model_group: "x", mode: "rerank" }), false)
})

test("лимиты и цены переводятся в формат opencode", () => {
  const m = toModel(groups[0]) as any
  assert.deepEqual(m.limit, { context: 1000000, output: 393216 })
  assert.equal(m.cost.input, 0.3) // $/1M из 3e-7 за токен
  assert.equal(m.cost.output, 1.2)
  assert.deepEqual(m.modalities.input, ["text", "image"])
  assert.equal(m.tool_call, true)
})

test("без лимитов от LiteLLM подставляются дефолты", () => {
  const m = toModel(groups[1]) as any
  assert.deepEqual(m.limit, { context: 128000, output: 8192 })
  assert.equal(m.reasoning, false)
})

test("уровень вне объявленного набора не уходит провайдеру", () => {
  const efforts = effortsByModel(groups)
  assert.deepEqual(efforts.get("deepseek-v4-flash"), ["none", "low", "high", "max"])
  assert.equal(efforts.has("qwen3.8-max"), false) // ничего не объявлено — набора нет

  assert.equal(allowedEffort(efforts.get("deepseek-v4-flash"), "high"), "high")
  // medium opencode предлагает всегда, а LiteLLM его для этой модели не объявляла → 400 у провайдера.
  assert.equal(allowedEffort(efforts.get("deepseek-v4-flash"), "medium"), undefined)
  // Про модель ничего не известно — не вмешиваемся.
  assert.equal(allowedEffort(undefined, "medium"), "medium")
  assert.equal(allowedEffort(efforts.get("deepseek-v4-flash"), undefined), undefined)
})

test("model_group/info берётся из корня прокси, а не из /v1", () => {
  assert.equal(proxyRoot("https://litellm.example/v1"), "https://litellm.example")
  assert.equal(proxyRoot("https://litellm.example/"), "https://litellm.example")
})

test("причина 401 берётся из тела ответа, а не из одного кода", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"error":{"message":"Authentication Error, No api key passed in."}}', {
      status: 401,
    })) as typeof fetch
  try {
    await assert.rejects(fetchGroups("https://litellm.example/v1"), /HTTP 401[\s\S]*No api key passed in/)
  } finally {
    globalThis.fetch = original
  }
})

test("только модели, доступные ключу, цена кэша из /model/info", () => {
  const groups: LiteLLMGroup[] = [
    { model_group: "deepseek-v4-pro", mode: "chat" },
    { model_group: "zai/glm-5.3", mode: "chat" },
  ]
  const allowed = keyModels([
    { model_name: "deepseek-v4-pro", model_info: { cache_read_input_token_cost: 4.4e-8 } },
    { model_name: "deepseek-v4-pro", model_info: { cache_read_input_token_cost: 9e-8 } },
  ])
  const models = toModels(groups, {}, allowed) as Record<string, { cost: { cache_read: number; cache_write: number } }>
  assert.deepEqual(Object.keys(models), ["deepseek-v4-pro"])
  assert.ok(Math.abs(models["deepseek-v4-pro"].cost.cache_read - 0.044) < 1e-9)
  assert.equal(models["deepseek-v4-pro"].cost.cache_write, 0)
  // /model/info недоступен → список не сужается, как раньше
  assert.deepEqual(Object.keys(toModels(groups)), ["deepseek-v4-pro", "zai/glm-5.3"])
})

test("reasoning, выключенный на всех деплойментах, убирает меню уровней", () => {
  const km = keyModels([
    { model_name: "qwen3.8-flash-no-reasoning", litellm_params: { enable_thinking: false } },
    { model_name: "deepseek-v4-flash-no-reasoning", litellm_params: { reasoning_effort: "none" } },
    { model_name: "deepseek-v4-flash", litellm_params: {} },
    { model_name: "mixed", litellm_params: { reasoning_effort: "none" } },
    { model_name: "mixed", litellm_params: {} },
  ])
  const group: LiteLLMGroup = { model_group: "x", supports_reasoning: true }
  assert.equal(toModel(group, {}, km.get("qwen3.8-flash-no-reasoning")).reasoning, false)
  assert.equal(toModel(group, {}, km.get("deepseek-v4-flash-no-reasoning")).reasoning, false)
  assert.equal(toModel(group, {}, km.get("deepseek-v4-flash")).reasoning, true)
  assert.equal(toModel(group, {}, km.get("mixed")).reasoning, true)
})

test("меню уровней opencode сводится к объявленным LiteLLM", () => {
  // deepseek-v4: none/low/high/max — medium и прочие выключены, max добавлен
  assert.deepEqual(variants(["none", "low", "high", "max"]), {
    minimal: { disabled: true }, medium: { disabled: true }, xhigh: { disabled: true },
    low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" },
  })
  assert.equal(variants(null), undefined)
  const m = toModel({ model_group: "d", supports_reasoning: true, supported_reasoning_efforts: ["low", "high"] }) as { variants?: object }
  assert.ok(m.variants)
  const off = toModel({ model_group: "d", supports_reasoning: false, supported_reasoning_efforts: ["low"] }) as { variants?: object }
  assert.equal(off.variants, undefined)
})
