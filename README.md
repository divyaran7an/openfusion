# OpenFusion

**A local-first studio for compound AI.** Wire a *council* of models on one canvas: Vercel AI Gateway models, Claude Code, and Codex. Then call the graph through one **OpenAI-compatible endpoint**.

OpenFusion follows the panel → judge → synthesizer pattern from [**OpenRouter's Fusion**](https://openrouter.ai/docs/guides/features/server-tools/fusion). You compose it locally, decide which models do which jobs, and can move expensive reasoning to flat-rate coding subscriptions where those local harnesses fit.

> Inspired by OpenRouter's Fusion. OpenFusion brings the same idea local, open, and composable. See [the credit](#inspired-by-openrouter).

![OpenFusion studio canvas showing a Gateway panel, Codex judge, Claude Code synthesizer, local endpoint bar, and chat run panel](docs/openfusion-hero.png)

```text
                       ┌──────────┐
prompt ─┬─▶ panel ─────┤          │
        ├─▶ panel ─────▶  judge   ├──▶ synthesizer ──▶ answer
        └─▶ panel ─────┤          │     (writes it)
                       └──────────┘
        answer in        compares,        grounds the final
        parallel         finds gaps       answer in the analysis
```

## Quickstart

```bash
git clone <your-fork-url> openfusion && cd openfusion
npm install
npm run dev            # opens http://127.0.0.1:3000
```

Open the studio, paste a [Vercel AI Gateway](https://vercel.com/ai-gateway) key right in the UI or sign into `claude` / `codex`, drag together a council, and point any OpenAI client at `http://127.0.0.1:3000/v1`. That's it. No API keys in files required, no restart.

## What it is

- **One canvas, one graph, one endpoint.** No modes, no presets you can't change, no hidden aliases. You add nodes; the endpoint runs *your* wiring. Edit the graph and the next call uses it.
- **Every node is a `source × model`:**
  - **Vercel AI Gateway:** Claude, GPT, Gemini, DeepSeek, Qwen, and more through one API-billed key.
  - **Claude Code:** your Claude Pro/Max subscription, run as a local reasoning node.
  - **Codex:** your ChatGPT/Codex subscription, the same.
- **Three roles, your call:** 1–8 **panel** models answer in parallel, an optional **judge** compares them at temperature 0 (consensus · contradictions · blind spots), and a **synthesizer** writes the final answer *grounded in that analysis*.
- **It's a conversation.** Ask follow-ups in the studio. It carries the thread while the council re-runs fresh each turn. The answer **token-streams**, and you **watch every model work** in a live run log with status, tools, output, cost.
- **It's an OpenAI endpoint.** Point Cursor, aider, Continue, the OpenAI SDK, or `curl` at it. Any model name works because it runs your active council.

## The route

```
prompt ─▶ panel (parallel) ─▶ judge (structured analysis) ─▶ synthesizer (final answer) ─▶ response
```

The judge never writes the reply. It **maps** where the panel agrees, disagrees, and what's missing. It compares, it doesn't vote or average. The synthesizer writes the best answer *using* that map. This is faithful to OpenRouter's Fusion, verified against their docs.

## Use it from any IDE or CLI

OpenFusion speaks the OpenAI Chat Completions API. Point any OpenAI-compatible client at:

```text
Base URL:  http://127.0.0.1:3000/v1
API key:   local-fusion     (any non-empty string; required only if you set FUSION_API_KEYS)
Model:     openfusion        (any name works; OpenFusion runs your active council)
```

The studio header shows the live endpoint as an address bar. Click it for one-click copy and per-client setup.

**curl**

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-fusion' \
  -H 'Content-Type: application/json' \
  -d '{"model":"openfusion","messages":[{"role":"user","content":"Postgres vs SQLite for a local-first app?"}]}'
```

Add `"stream": true` for OpenAI-style SSE (terminated by `[DONE]`).

**OpenAI SDK** (Python / Node)

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="local-fusion")
print(client.chat.completions.create(
    model="openfusion",
    messages=[{"role": "user", "content": "Where would this plan fail?"}],
).choices[0].message.content)
```

**Cursor:** Settings → Models → OpenAI API → *Override OpenAI Base URL*: `http://127.0.0.1:3000/v1`, key `local-fusion`, model `openfusion`.
**aider:** `aider --openai-api-base http://127.0.0.1:3000/v1 --openai-api-key local-fusion --model openfusion`.
**Continue / OpenCode / others:** same three values. Full client list in **[docs/SETUP.md](docs/SETUP.md)**.

**Want to try the wire first?** [`examples/chat`](examples/chat) is a tiny streaming chat with a terminal client, a browser page, and copy-paste configs for common CLIs and IDEs.

## The studio

- **Canvas:** drag nodes; edges are implied by role (panels → judge → synthesizer). Each node sets its source, model, thinking effort, and web tools inline.
- **Presets** (⚙ → Quality / Balanced / Fast) rewire the whole council in one click; **Council settings** expose the shared tool budget, temperature, strict mode, and the model id clients call.
- **Live run log:** when you send a prompt, every model lights up with status, streamed output, tool calls, tokens, and cost.
- **Stop** actually stops. It cancels the upstream model calls, so you never keep burning Gateway quota after you hit it.

## Models

OpenFusion ships an opinionated, current shortlist per source. **Any id the source accepts works** via *Custom…*:

| Source | Models |
| --- | --- |
| **Vercel AI Gateway** | `anthropic/claude-opus-4.8` · `openai/gpt-5.5` · `google/gemini-3-pro-preview` · `anthropic/claude-sonnet-4.6` · `google/gemini-3.5-flash` · `deepseek/deepseek-v4-pro` … |
| **Claude Code** | `opus` (4.8) · `sonnet` (4.6) · `haiku` (4.5) |
| **Codex** | `gpt-5.5` (default) · `gpt-5.5-codex` |

The default Quality council mirrors OpenRouter's: three distinct frontier families (Opus · GPT · Gemini) on the panel. Full guidance lives in **[docs/MODELS.md](docs/MODELS.md)**.

## Subscriptions as nodes

Log into your CLIs once with `claude auth login` and `codex login`. The **Claude Code** / **Codex** sources go Connected automatically, then you add their nodes on the canvas. They run **read-only with web search built in**. No file edits, no host mutations, no token scraping, no browser automation. Official local clients only. See [SECURITY.md](SECURITY.md).

## Why

Panels beat soloists (OpenRouter's DRACO results), and builders already pay flat-rate for the best coding models. OpenFusion is the missing layer: **use the subscriptions you have, add the Gateway for breadth, and compose it all into one reliable compound endpoint you can point any tool at.**

## Inspired by OpenRouter

OpenFusion's pipeline is modeled directly on [**OpenRouter's Fusion**](https://openrouter.ai/docs/guides/features/server-tools/fusion): a parallel panel, a temperature-0 judge that produces structured analysis, and a synthesizer that writes from it. We verified the behavior against their docs and kept it faithful. The judge *compares* rather than votes; the synthesizer *grounds* rather than concatenates. What OpenFusion adds is **local-first, open, and composable**. You own the graph, you bring your own subscriptions, and nothing leaves your machine unless you wire it to.

## Docs

- **[Setup](docs/SETUP.md):** install, connect sources, plug into every IDE/CLI
- **[Models](docs/MODELS.md):** the current models per source, how to pick, custom ids
- **[API](docs/API.md):** the OpenAI-compatible surface in full
- **[Architecture](docs/ARCHITECTURE.md):** how the council runs, end to end
- **[Principles](PRINCIPLES.md):** what OpenFusion stands for
- **[Security](SECURITY.md)** · **[Contributing](CONTRIBUTING.md)**

## Contributors

- [Divya Ranjan](https://x.com/divyaranjan_) - creator and maintainer

## License

MIT.

Built with [Pattrns.ai](https://pattrns.ai) by [@divyaranjan_](https://x.com/divyaranjan_).
