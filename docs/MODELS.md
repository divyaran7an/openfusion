# Models

Every node in OpenFusion is a **`source × model`**. The studio ships an opinionated, current shortlist per source so you never have to guess an id. **Any id the source accepts works** via the *Custom…* option in the model dropdown.

There are three sources: **Vercel AI Gateway** (one key, every frontier model, API-billed) and the two local-CLI harnesses **Claude Code** and **Codex** (run on your subscription, no per-token API bill).

---

## Vercel AI Gateway

API-billed access to every major provider through one key. The studio's shortlist (June 2026):

| Model | Good for |
| --- | --- |
| `anthropic/claude-opus-4.8` | Frontier reasoning, agentic work, long tasks |
| `openai/gpt-5.5` | Frontier general + coding |
| `google/gemini-3-pro-preview` | Frontier, a distinct third family + long context |
| `anthropic/claude-sonnet-4.6` | Strong and faster than Opus |
| `google/gemini-3.5-flash` | Fast, cheap, capable |
| `deepseek/deepseek-v4-pro` | Strong open model |
| `deepseek/deepseek-v4-flash` | Cheap/fast open model |
| `alibaba/qwen3.7-max` | Strong open frontier alternative |

The first three are distinct frontier families and form the default **Quality** council (mirroring OpenRouter's default Fusion panel).

**The full, live list.** The shortlist is curated, not exhaustive. The Gateway serves hundreds of models, and the canonical list includes ids, context windows, and pricing. It is a public, **no-auth, no-cost** endpoint:

```bash
curl https://ai-gateway.vercel.sh/v1/models
```

Pick any `id` from there and paste it into a node via *Custom…*. This is also why OpenFusion uses verified ids: choosing a model the Gateway doesn't serve produces an empty "No output generated" run. The live list is the source of truth.

Get a key at [vercel.com/ai-gateway](https://vercel.com/ai-gateway), then paste it directly in the studio (stored locally, masked, no restart) or set `AI_GATEWAY_API_KEY` in `.env.local`.

---

## Claude Code

Runs your Claude Pro/Max subscription via the official `claude` CLI as a real council node. **No API bill.** Sign in once (`claude auth login`) and the source goes Connected.

| Alias | Resolves to |
| --- | --- |
| `opus` | Claude Opus 4.8 |
| `sonnet` | Claude Sonnet 4.6 |
| `haiku` | Claude Haiku 4.5 |

The aliases always track the latest in each class. To pin an exact version, type the full id via *Custom…* (e.g. `claude-opus-4-8`). Claude Code nodes run **read-only with web search built in**. They ground themselves in current sources but never touch your files or host.

---

## Codex

Runs your ChatGPT/Codex subscription via the official `codex` CLI. **No API bill.** Sign in once (`codex login`) and the source goes Connected.

| Model | Notes |
| --- | --- |
| `gpt-5.5` | **Current Codex default**, strong general + coding |
| `gpt-5.5-codex` | Coding-tuned variant |
| `gpt-5.4` | Previous generation |

> Note: GPT-5.5 (not `gpt-5.5-codex`) is Codex CLI's current default model. Codex nodes run in a **read-only sandbox with web search**. They can search and inspect, never mutate the host.

---

## Picking a council

Open **⚙ → presets** in the studio for one-click councils:

- **Quality:** `claude-opus-4.8` · `gpt-5.5` · `gemini-3-pro-preview` panel, GPT judge, Opus synthesizer. Three frontier families; the default.
- **Balanced:** Sonnet · GPT · DeepSeek-v4-pro panel; strong, lighter cost.
- **Fast:** Gemini Flash · DeepSeek Flash panel; quick and lean.

A council needs **at least one panel** and **exactly one synthesizer**; the **judge is optional** and only runs when there's more than one panel to compare. Mix sources freely, for example a Claude Code panelist next to two Gateway models, with a Codex synthesizer.

## Thinking effort

Each node has its own **thinking budget**: `minimal · low · medium · high · max`. Set it on the node, not globally. It maps to each backend's own knob:

- **Claude Code** → `--effort` (`max` reaches `xhigh` on Opus-class models)
- **Codex** → `model_reasoning_effort`
- **Gateway** → provider reasoning options (OpenAI `reasoningEffort`, Anthropic adaptive thinking, Google `thinkingBudget`)

The shared **tool budget** (max tool calls per node) and **temperature** are set once in **⚙ Council settings**. The judge always runs at temperature 0.

## Custom ids

Any model your source accepts works: choose **Custom…** in a node's model dropdown and paste the id. Gateway ids are `provider/model` (from the live list above); Claude Code and Codex take their own local model names. The endpoint runs whatever you wired. There is no allow-list to fight.
