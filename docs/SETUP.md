# Setup

This guide gets OpenFusion running locally and explains where credentials, workflow routing, client setup, and subscriptions fit.

## Mental Model

| Thing | Purpose | Goes into OpenFusion runtime? |
| --- | --- | --- |
| Vercel AI Gateway key | Real model calls through AI SDK Gateway | Yes. Paste in the studio or set `AI_GATEWAY_API_KEY` |
| Parallel API key | Optional richer web extraction/search | Yes, `PARALLEL_API_KEY` |
| `FUSION_API_KEYS` | Local auth for clients calling OpenFusion | Yes, optional |
| Codex / ChatGPT plan | A runnable council node, via the local Codex CLI | Not as an API key. The CLI |
| Claude Code Pro/Max | A runnable council node, via the local Claude Code CLI | Not as an API key. The CLI |
| OpenCode/Cursor/Cline config | Points a client at OpenFusion's local `/v1` endpoint | Client-side |

Subscriptions run real council nodes through their official local CLIs (read-only print mode), so the panel/judge/synthesizer work they do is billed to your flat-rate plan, not per-token. Gateway nodes are the API-billed path.

The browser UI is the studio: a node canvas (`http://127.0.0.1:3000`) where you compose the graph that every `/v1/chat/completions` request runs. Day-to-day clients call the endpoint; you shape what it does on the canvas.

## Install

```bash
npm install
cp .env.example .env.local
```

To run Gateway models you need an AI Gateway key. You can either paste it into the
studio. Click the **Gateway** chip → paste your key → **Save key** (stored locally
under `.fusion/`, used immediately, no restart), or set it in `.env.local`:

```bash
AI_GATEWAY_API_KEY=...
```

(A studio-set key takes precedence over the environment. Claude Code / Codex need no
key. Just log into their CLIs.)

Optional:

```bash
PARALLEL_API_KEY=...
FUSION_API_KEYS=local-fusion
FUSION_API_KEY=local-fusion
FUSION_LOCAL_ROOTS=/Users/you/projects
FUSION_WEB_FETCH=1
```

Do not commit `.env.local`.

## Verify Models

OpenFusion defaults are configuration, not hardcoded magic. Inspect the live Vercel AI Gateway catalog before relying on them:

```bash
curl https://ai-gateway.vercel.sh/v1/models
```

As of June 25, 2026, the public Gateway catalog includes every default in `.env.example`. Your account may still differ by provider access, billing state, region, or date.

Your `/v1/chat/completions` requests run the **active graph** you compose in the studio. The model you pick per node is what runs. The `FUSION_*_MODELS` environment variables (`FUSION_FAST_MODEL`, `FUSION_RESEARCH_MODEL`, `FUSION_FUSION3_MODELS`, `FUSION_FUSION8_MODELS`, `FUSION_JUDGE_MODEL`, `FUSION_OUTER_MODEL`) only seed legacy compatibility defaults for the older `/api/runs` path; they do **not** change what your graph runs. Choose models on the canvas, not here.

## Run

Default port:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

OpenCode-friendly port:

```bash
npm run dev:opencode
```

That starts OpenFusion on `http://127.0.0.1:3001`, matching `opencode.json`.

## Check Without Spending Credits

```bash
npm run verify
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/v1/models
```

These checks do not run paid completions. To test a real run, use the studio or a normal OpenAI-compatible client with your own provider credentials.

## The Studio (the canvas)

Open `http://127.0.0.1:3000`. The studio is a node canvas, not a chat window. You compose one graph:

- **Panel** nodes (1–8) answer in parallel.
- An optional **Judge** compares them at temperature 0: consensus, contradictions, blind spots.
- One **Synthesizer** writes the final answer grounded in the judge's analysis.

OpenFusion's panel → judge → synthesizer pipeline is faithful to (and inspired by) OpenRouter's Fusion.

Each node is a **source × model**. Pick the source from the chip on the node: **Gateway** (Vercel AI Gateway models), **Claude Code**, or **Codex**. Then pick the model, a per-node thinking budget, and whether it gets web tools. Click a source chip in the top bar to see its connection status and how to connect it.

Whatever graph is active is what every `/v1/chat/completions` request runs. Edit the graph and the next call uses the new wiring. Nothing to redeploy. OpenFusion ships with a runnable default council (three Gateway panels → judge → synthesizer), so a fresh install with `AI_GATEWAY_API_KEY` set answers immediately. Empty the graph and calls fail loudly (`Your OpenFusion graph isn't runnable yet…`) rather than guessing.

## Plug OpenFusion into your IDE or CLI

OpenFusion speaks the OpenAI API. Point any OpenAI-compatible client at:

```text
Base URL:  http://127.0.0.1:3000/v1
API key:   local-fusion     (any non-empty string; required only if you set FUSION_API_KEYS)
Model:     fusion           (any name works; OpenFusion runs your active graph)
```

If you set `FUSION_API_KEYS=key1,key2`, clients must send one of those keys (`Authorization: Bearer <key>` or the `x-fusion-api-key` header). Otherwise auth is open for local use.

### curl

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-fusion' \
  -H 'Content-Type: application/json' \
  -d '{"model":"fusion","messages":[{"role":"user","content":"Compare Postgres vs SQLite for a local-first app."}]}'
```

Add `"stream": true` for OpenAI-compatible SSE (terminated by `[DONE]`).

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="local-fusion")
resp = client.chat.completions.create(
    model="fusion",
    messages=[{"role": "user", "content": "Where would this plan fail?"}],
)
print(resp.choices[0].message.content)
```

### OpenAI Node SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:3000/v1", apiKey: "local-fusion" });
const resp = await client.chat.completions.create({
  model: "fusion",
  messages: [{ role: "user", content: "Review this architecture." }],
});
console.log(resp.choices[0].message.content);
```

### Cursor

Settings → Models → OpenAI API → enable **Override OpenAI Base URL**:

```text
OpenAI Base URL:  http://127.0.0.1:3000/v1
OpenAI API Key:   local-fusion
Model:            fusion
```

Any model name reaches OpenFusion intact and runs your graph, so Cursor's built-in model strings work too. If Cursor blocks an unknown model ID *before* the request leaves the app, map a Cursor-accepted label with `FUSION_MODEL_ALIASES=gpt-4o=fusion` and select it.

### Continue.dev

In `~/.continue/config.json`:

```json
{
  "models": [
    { "title": "OpenFusion", "provider": "openai", "model": "fusion",
      "apiBase": "http://127.0.0.1:3000/v1", "apiKey": "local-fusion" }
  ]
}
```

### aider

```bash
aider --openai-api-base http://127.0.0.1:3000/v1 \
      --openai-api-key local-fusion \
      --model openai/fusion
```

### OpenCode

OpenFusion ships a checked-in `opencode.json` (port 3001):

```bash
npm run dev:opencode
OPENCODE_CONFIG=/path/to/fusion/opencode.json opencode
```

Run `/models` and choose the OpenFusion label. If the provider picker opens, press `esc`. Do not pick OpenAI/Anthropic/OpenRouter for this local setup.

Legacy model aliases still resolve for older clients: `openrouter/fusion`, `fusion/fusion`, `fusion-3`, `fusion-8`, `research`, `fast`.

## Subscriptions

Codex and Claude Code subscriptions run as local council nodes through their official CLIs. They are not API keys for `/v1/chat/completions`; the runtime starts the signed-in local client in read-only print mode and normalizes the result.

The Codex and Claude Code integrations are local harness adapters with:

- official local client usage (read-only, print mode)
- scratch workspaces for isolated execution
- transcripts and provenance

**They connect automatically.** Install the CLI and sign in, and the matching source goes "Connected" in the studio. No env flag to set. The optional opt-out is `FUSION_CODEX_HARNESS=0` / `FUSION_CLAUDE_CODE_HARNESS=0`, which forces a harness off even when its CLI is present.

## Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `503 configuration_required` | Runtime provider credentials are missing | Set `AI_GATEWAY_API_KEY` |
| `Your OpenFusion graph isn't runnable yet…` | The active graph has no panel, or not exactly one synthesizer | Open the studio: add ≥1 panel node and exactly one synthesizer |
| `401 unauthorized` | Local auth is enabled and client key is missing or wrong | Send `Authorization: Bearer <key>` |
| `400 invalid_request_error` | Unsupported model, tool, or request shape | Check `/v1/models` and the API docs |
| Client says model not found, OpenFusion logs no request | Client rejected the model locally | Use `FUSION_MODEL_ALIASES` |
| OpenCode shows built-in models | OpenCode did not load `opencode.json` | Start with `OPENCODE_CONFIG=/path/to/fusion/opencode.json` |
