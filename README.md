# opencode-litellm-models

An [opencode](https://opencode.ai) plugin that fills in the models of a LiteLLM proxy by itself.
You declare the provider once; every model the proxy serves you shows up in opencode — no
per-model entries in `opencode.json`, nothing to update when the proxy changes.

Models are read from LiteLLM's `GET /model_group/info`, which lists what your key's team
actually has (unlike `/v1/model/info`, whose output depends on the key and is often empty).

## Install

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-litellm-models"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": {
        "baseURL": "https://litellm.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      },
      "models": {}
    }
  }
}
```

`models` stays empty — the plugin fills it. Anything you do put there wins over what was
discovered, so pinning one model with custom limits still works.

Check it: `opencode models litellm`.

## Options

Pass options with the array form: `"plugin": [["opencode-litellm-models", { "provider": "my-litellm" }]]`.

| option | default | meaning |
|---|---|---|
| `provider` | `"litellm"` | id of the provider block to fill |
| `baseURL` | provider's `options.baseURL`, else `$LITELLM_BASE_URL` | proxy address |
| `defaultContext` | `128000` | context limit for models LiteLLM reports no limits for |
| `defaultOutput` | `8192` | output limit for the same |

The key is taken from the provider's `options.apiKey`, else `$LITELLM_API_KEY`.

## What it does with reasoning levels

opencode offers a fixed menu of reasoning levels (`low`/`medium`/`high`/…) for every model that
reports `reasoning: true`, and the config cannot narrow that menu. LiteLLM, meanwhile, publishes
the levels a model really takes in `supported_reasoning_efforts`. Sending a level the provider
does not take is a 400, which puts the deployment into cooldown and turns into 429s for everyone
on that proxy.

So when LiteLLM announces a set for a model, the plugin drops a request-level
`reasoningEffort` outside that set instead of forwarding it — the model's own default is used.
When LiteLLM announces nothing, the plugin does not interfere.

## Notes

- Embeddings, rerank and other non-chat modes are filtered out; a model with `mode: null` is kept
  (LiteLLM leaves it empty for plenty of working chat models).
- If the proxy is unreachable or answers with an error, the config is left untouched: a provider
  with an empty model list would not load at all.
- Discovered ≠ callable: `/model_group/info` lists the team's models, and a key may still be
  denied a particular one (403 at request time).

## Development

```sh
npm test   # node --test, no dependencies
```

MIT
