# Models

Every node in OpenFusion is a **`source x model`**. The studio ships an opinionated, current shortlist per source so you never have to guess an id. **Any id the source accepts works** via the *Custom ID* option in the model dropdown.

There are four sources: **Vercel AI Gateway** and **OpenRouter** for hosted API-billed models, plus the two local-CLI harnesses **Claude Code** and **Codex** for plan-backed usage through the official CLIs, subject to each provider's limits and billing rules.

---

## Vercel AI Gateway

API-billed access to a large hosted model catalog through one key. The studio's shortlist, verified against the public Vercel AI Gateway catalog on July 2, 2026:

| Model | Good for |
| --- | --- |
| `anthropic/claude-opus-4.8` | High-capability reasoning, agentic work, long tasks |
| `openai/gpt-5.5` | High-capability general + coding |
| `google/gemini-3.1-pro-preview` | Distinct third family + long context |
| `anthropic/claude-fable-5` | Anthropic's deep-research model, strong on long-horizon tasks |
| `anthropic/claude-sonnet-5` | Strong and faster than Opus |
| `moonshotai/kimi-k2.6` | Latest general Kimi (`k2.7` is the code-tuned line) |
| `deepseek/deepseek-v4-pro` | Strong open model |
| `google/gemini-3.5-flash` | Fast, cheap, capable |
| `deepseek/deepseek-v4-flash` | Cheap/fast open model |
| `alibaba/qwen3.7-max` | Strong open alternative |

The first three are distinct model families and form the default **Quality** council. This follows the same shape as OpenRouter's Quality preset: a diverse panel rather than one model doing everything.

**The full, live list.** The shortlist is curated, not exhaustive. The Vercel AI Gateway catalog changes over time, and the public list includes ids, context windows, and pricing when available:

```bash
curl https://ai-gateway.vercel.sh/v1/models
```

Pick any `id` from there and paste it into a node via *Custom ID*. This is also why OpenFusion uses verified ids: choosing a model Vercel AI Gateway doesn't serve produces an empty "No output generated" run. The live list is the source of truth.

Get a key at [vercel.com/ai-gateway](https://vercel.com/ai-gateway), then paste it directly in the studio (stored locally, masked, no restart) or set `AI_GATEWAY_API_KEY` in `.env.local`.

---

## OpenRouter

API-billed access to OpenRouter's model catalog, routers, and server-side tools through one key. The studio shortlist uses normal OpenRouter model ids:

| Model | Good for |
| --- | --- |
| `anthropic/claude-opus-4.8` | High-capability reasoning and synthesis |
| `openai/gpt-5.5` | Strong general and coding work |
| `google/gemini-3.1-pro-preview` | Distinct third family and long context |
| `anthropic/claude-fable-5` | Anthropic's deep-research model |
| `anthropic/claude-sonnet-5` | Strong, faster Claude option |
| `moonshotai/kimi-k2.6` | Strong open model |
| `deepseek/deepseek-v4-pro` | Strong open model |
| `google/gemini-3.5-flash` | Fast, cheap, capable |
| `openrouter/auto` | OpenRouter's router selection |
| `openrouter/fusion` | OpenRouter's own Fusion model alias |

OpenFusion is still the orchestrator. Choosing OpenRouter as a node source means that node is called through OpenRouter. It does not replace your OpenFusion graph with OpenRouter's hosted Fusion pipeline unless you explicitly choose `openrouter/fusion` as that node's model.

The live OpenRouter catalog is the source of truth:

```bash
curl https://openrouter.ai/api/v1/models
```

Get a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), then paste it directly in the studio (stored locally, masked, no restart) or set `OPENROUTER_API_KEY` in `.env.local`.

OpenRouter nodes use OpenRouter server-side `web_search` and `web_fetch` when the node's web toggle is on. That matches the Fusion idea more closely than a local fetch shim: OpenRouter executes those tools for the model call, then OpenFusion records the result and moves to judge or synthesis.

---

## Claude Code

Runs Claude Code via the official `claude` CLI as a real council node. If you authenticate with a Pro or Max plan, usage counts against that plan's Claude Code limits unless you choose an API-credit path in Claude Code. Sign in once (`claude auth login`) and the source goes Connected when the CLI is installed and local auth or provider credentials are present. The first run still verifies the upstream account can execute.

| Alias | Resolves to |
| --- | --- |
| `fable` | The CLI's current Fable model (Anthropic's deep-research line) |
| `opus` | The CLI's current Opus tier |
| `sonnet` | The CLI's current Sonnet tier |
| `haiku` | The CLI's current Haiku tier |

The aliases track whatever your installed Claude Code CLI currently maps them to, so a CLI update can move them to a newer model.

These aliases are passed to the local Claude Code CLI. To pin an exact version, type the full id via *Custom ID* (e.g. `claude-fable-5`). OpenFusion invokes Claude Code nodes in read-only, no-session-persistence mode with web search/fetch tools enabled where the CLI supports them. They do not get file-edit access from OpenFusion.

By default, Claude Code uses whatever account the local CLI is signed into. For a separate OpenFusion-only login/cache, set `FUSION_CLAUDE_CODE_HOME`. For a gateway-backed Claude Code run, set `FUSION_CLAUDE_CODE_ENV_JSON`, but treat that as gateway billing. For example, OpenRouter's Claude Code path uses `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<OpenRouter key>`, and `ANTHROPIC_API_KEY=""`, which routes the run through OpenRouter instead of a Claude subscription.

---

## Codex

Runs Codex via the official `codex` CLI. Codex usage is included with eligible ChatGPT plans, with limits and credit options varying by plan. Sign in once (`codex login`) and the source goes Connected when the CLI is installed and local auth or provider credentials are present. The first run still verifies the upstream account can execute.

| Model | Notes |
| --- | --- |
| `gpt-5.5` | OpenFusion's default Codex node, strong general + coding |
| `gpt-5.5-codex` | Coding-tuned variant |
| `gpt-5.4` | Previous generation |

> Note: The Codex CLI's default can depend on CLI version and local configuration. OpenFusion defaults Codex nodes to `gpt-5.5`. Codex nodes run in an isolated read-only scratch sandbox with web search enabled where supported. They can ground themselves in web results, but they do not inspect or mutate your host files through the harness. Use OpenFusion's scoped local tools for local file inspection.

Use `FUSION_CODEX_HOME` when OpenFusion should use a separate Codex login from your normal terminal. OpenFusion runs Codex with `--ignore-user-config --ignore-rules`, so stale user config or project execpolicy rules should not break council runs.

---

## Picking a council

Open **Settings -> presets** in the studio for one-click councils:

- **Quality:** `claude-opus-4.8`, `gpt-5.5`, `gemini-3.1-pro-preview` panel, GPT judge, Opus synthesizer. Three distinct model families; the default.
- **Balanced:** Sonnet 5, GPT, DeepSeek-v4-pro panel; strong, lower-cost than Quality for hosted-only runs.
- **Fast:** Gemini Flash, DeepSeek Flash panel; quick and lean.

A council needs **at least one panel** and **exactly one synthesizer**; the **judge is optional** and only runs when there's more than one panel to compare. Mix sources freely, for example a Claude Code panelist next to a Vercel AI Gateway model and an OpenRouter model, with a Codex synthesizer.

## Thinking effort

Each node has its own **thinking budget**: `minimal`, `low`, `medium`, `high`, `max`. Set it on the node, not globally. It maps to each backend's own knob:

- **Claude Code** -> `--effort` (`max` reaches `xhigh` on Opus-class models)
- **Codex** -> `model_reasoning_effort`
- **Vercel AI Gateway** -> provider reasoning options (OpenAI `reasoningEffort`, Anthropic adaptive thinking, Google `thinkingBudget`)
- **OpenRouter** -> OpenRouter `reasoning.effort`

The shared **tool budget** (max tool calls per node) and **temperature** are set once in **Council settings**. The judge always runs at temperature 0.

## Custom ids

Any model your source accepts works: choose **Custom ID** in a node's model dropdown and paste the id. Vercel AI Gateway and OpenRouter ids are `provider/model` from their live catalogs; Claude Code and Codex take their own local model names. The endpoint runs whatever you wired. There is no allow-list to fight.
