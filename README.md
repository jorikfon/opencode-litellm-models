# opencode-litellm-models

An [opencode](https://opencode.ai) plugin that fills in the models of a LiteLLM proxy by itself.
You declare the provider once; every model the proxy serves you shows up in opencode — no
per-model entries in `opencode.json`, nothing to update when the proxy changes.

Models are read from LiteLLM's `GET /model_group/info` (limits, prices, reasoning levels) and
narrowed to the ones `GET /model/info` lists for your key, so a model the key may not call does not
show up only to answer 403. Prompt-cache prices come from `/model/info` too. If `/model/info` fails
or comes back empty, every model group is shown, as before, and a `[litellm] model/info: …` line
says why.

## Install

Put the plugin where opencode looks for local ones — `~/.config/opencode/plugin/litellm.ts` for
every project, or `.opencode/plugin/litellm.ts` for one:

```ts
export { LitellmModels } from "/path/to/opencode-litellm-models/index.ts"
```

On Windows the layout is the same: opencode looks in `%USERPROFILE%\.config\opencode\plugin\`
(or under `$XDG_CONFIG_HOME` when it is set), and the re-export takes a URL:
`export { LitellmModels } from "file:///C:/Users/you/opencode-litellm-models/index.ts"`.
The plugin itself is platform-agnostic — it only talks HTTP and edits the loaded config. This
was developed and tested on macOS; the Windows path above follows opencode's own resolution
(`$XDG_CONFIG_HOME`, else the home directory plus `.config`) rather than a test run.

Then declare the provider:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
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

The package is not on npm, so the local file is the way to install it. A convenient home for the
clone is `~/.local/share/opencode-litellm-models`; `git pull` there upgrades the plugin.

Verified on opencode 1.18.22 and 1.18.31.

## Options

Options come from the array form of the `plugin` entry —
`"plugin": [["opencode-litellm-models", { "provider": "my-litellm" }]]` — or, with a local file,
by passing them yourself: `export const Litellm = (input, opts) => LitellmModels(input, { ...opts, provider: "my-litellm" })`.

| option | default | meaning |
|---|---|---|
| `provider` | `"litellm"` | id of the provider block to fill |
| `baseURL` | provider's `options.baseURL`, else `$LITELLM_BASE_URL` | proxy address |
| `defaultContext` | `128000` | context limit for models LiteLLM reports no limits for |
| `defaultOutput` | `8192` | output limit for the same |

The key is taken from the provider's own options, else from `$LITELLM_API_KEY`.

## What it does with reasoning levels

LiteLLM publishes the levels a model really takes in `supported_reasoning_efforts`; sending a level
the provider does not take is a 400, which puts the deployment into cooldown and turns into 429s for
everyone on that proxy. opencode builds its own level menu per model, so the plugin writes the
model's `variants`: levels outside LiteLLM's set get `{"disabled": true}`, levels opencode lacks
(e.g. `max`) are added with that `reasoningEffort`. `none` gets no entry — it is the model without a
level. The menu then shows exactly LiteLLM's levels (checked on opencode 1.18.32: deepseek-v4 and
glm-5.3 show low/high/max). A request-level `reasoningEffort` outside the set is still dropped
before it is sent, as a safety net. When LiteLLM announces nothing, neither the menu nor the request
is touched.

A model with reasoning switched off on the deployment itself (`reasoning_effort: "none"`, `enable_thinking: false` or `thinking.type: "disabled"` in `litellm_params` of every deployment, as `/model/info` shows them) gets `reasoning: false`, so opencode shows no level menu for it — that
is how `*-no-reasoning` groups look, even though LiteLLM reports `supports_reasoning: true` for
them. Only those reasoning fields are read from `litellm_params`; the rest of it (provider
credentials) is neither kept nor logged.

## Notes

- Embeddings, rerank and other non-chat modes are filtered out; a model with `mode: null` is kept
  (LiteLLM leaves it empty for plenty of working chat models).
- If the proxy is unreachable or answers with an error, the config is left untouched (a provider
  with an empty model list would not load at all) and a `[litellm] …` line on stderr names the
  cause.
- When `/model/info` is unavailable the list is not narrowed, and a model outside the key's team
  answers 403 at request time.

## When no models show up

`Error: Provider not found: litellm` means the provider ended up with no models, so opencode never
registered it. The plugin prints the reason right before that line:

```
[litellm] litellm: could not read the model list (Error: model_group/info: HTTP 401
{"error":{"message":"Authentication Error, No api key passed in.",…}}); leaving the config as it is
```

LiteLLM's own body is quoted, and its two 401s mean different things:

- **`No api key passed in`** — the request went out without credentials. With an `{env:…}`
  template in the config this is a missing variable: opencode resolves the template when it loads
  the config, and an unset variable becomes an empty string. The variable has to be set *in the
  process that runs opencode*, so a desktop session that exports it and an IDE or a
  non-interactive `ssh` session that doesn't behave differently. The plugin makes its own HTTP
  call, so `opencode auth login` does not cover it.
- **`Unable to find token in cache or LiteLLM_VerificationTokenTable`** (`token_not_found_in_db`)
  — credentials did arrive, but the proxy does not know them: revoked, rotated, or issued by
  another proxy. The body echoes them masked, with only the last digits left, so you can tell
  which one opencode actually sent.
- **403, or an empty list** — the credentials are fine, but that team has no models on the proxy.
- **No `[litellm]` line at all** — the plugin was not loaded: check the path and the exported name
  in `~/.config/opencode/plugin/litellm.ts`.

## Development

```sh
npm test   # node --test, no dependencies
```

MIT
