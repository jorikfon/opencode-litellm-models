# opencode-litellm-models

An [opencode](https://opencode.ai) plugin that fills in the models of a LiteLLM proxy by itself.
You declare the provider once; every model the proxy serves you shows up in opencode — no
per-model entries in `opencode.json`, nothing to update when the proxy changes.

Models are read from LiteLLM's `GET /model_group/info`, which lists what your key's team
actually has (unlike `/v1/model/info`, whose output depends on the key and is often empty).

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
- If the proxy is unreachable or answers with an error, the config is left untouched (a provider
  with an empty model list would not load at all) and a `[litellm] …` line on stderr names the
  cause.
- Discovered ≠ callable: `/model_group/info` lists the team's models, and a key may still be
  denied a particular one (403 at request time).

## When no models show up

`Error: Provider not found: litellm` means the provider ended up with no models, so opencode never
registered it. The plugin prints the reason right before that line:

```
[litellm] litellm: could not read the model list (Error: model_group/info: HTTP 401); leaving the config as it is
```

- **401 while the key in the config is an `{env:…}` template** — opencode resolves that template
  when it loads the config, and if the variable is missing *in the process that runs opencode*, it
  resolves to an empty string and the request goes out without credentials. A desktop session that
  has the variable and a non-interactive `ssh` session that doesn't will therefore behave
  differently. Export the variable for the process that actually runs opencode.
- **403, or an empty list** — the credentials are fine, but that team has no models on the proxy.
- **No `[litellm]` line at all** — the plugin was not loaded: check the path and the exported name
  in `~/.config/opencode/plugin/litellm.ts`.

## Development

```sh
npm test   # node --test, no dependencies
```

MIT
