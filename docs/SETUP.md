# Setup

This guide gets OpenFusion running locally and explains where credentials, workflow routing, client setup, and subscriptions fit.

## Mental Model

| Thing | Purpose | Goes into OpenFusion runtime? |
| --- | --- | --- |
| Vercel AI Gateway key | Real model calls through Vercel AI Gateway | Yes. Paste in the studio or set `AI_GATEWAY_API_KEY` |
| OpenRouter key | Real model calls, routers, and OpenRouter server tools | Yes. Paste in the studio or set `OPENROUTER_API_KEY` |
| Parallel API key | Optional richer web extraction/search | Yes, `PARALLEL_API_KEY` |
| `FUSION_API_KEYS` | Local auth for clients calling OpenFusion | Yes, optional |
| Codex / ChatGPT plan | A runnable council node, via the local Codex CLI | Not as an API key. The CLI |
| Claude Code Pro/Max | A runnable council node, via the local Claude Code CLI | Not as an API key. The CLI |
| OpenCode/Cursor/Cline config | Points a client at OpenFusion's local `/v1` endpoint | Client-side |

Subscriptions run real council nodes through their official local CLIs (read-only print mode), so the panel/judge/synthesizer work counts against those plan limits instead of hosted per-token billing. Provider rules still apply: Claude Code can offer API-credit fallback, and Codex usage limits/credits vary by ChatGPT plan. Vercel AI Gateway and OpenRouter nodes are the API-billed paths.

The browser UI is the studio: a node canvas (`http://127.0.0.1:3000`) where you compose the graph that every `/v1/chat/completions` request runs. Day-to-day clients call the endpoint; you shape what it does on the canvas.

## Install

```bash
npm install
cp .env.example .env.local
```

To run Vercel AI Gateway models, you need a Vercel AI Gateway key. You can either paste it into the
studio. Click the **Vercel AI Gateway** chip -> paste your key -> **Save key** (stored locally
under `.fusion/`, used immediately, no restart), or set it in `.env.local`:

```bash
AI_GATEWAY_API_KEY=<vercel-ai-gateway-key>
```

To run OpenRouter models, do the same with the **OpenRouter** chip, or set:

```bash
OPENROUTER_API_KEY=<openrouter-key>
```

(A studio-set key takes precedence over the environment. Claude Code / Codex need no
key. Just log into their CLIs.)

Optional:

```bash
PARALLEL_API_KEY=<parallel-key>
FUSION_API_KEYS=local-fusion
FUSION_API_KEY=local-fusion
FUSION_LOCAL_ROOTS=/path/to/projects
FUSION_WEB_FETCH=1
```

Do not commit `.env.local`.

## Verify Models

OpenFusion defaults are configuration, not hardcoded magic. Inspect the live catalogs before relying on them:

```bash
curl https://ai-gateway.vercel.sh/v1/models
curl https://openrouter.ai/api/v1/models
```

As of July 1, 2026, the public Vercel AI Gateway and OpenRouter catalogs include the hosted examples in the studio. Your account may still differ by provider access, billing state, region, or date.

Your `/v1/chat/completions` requests run the **active graph** you compose in the studio. The model you pick per node is what runs. Choose models on the canvas. Environment variables are for credentials, auth, storage, tool safety, and harness process isolation, not for shaping the council.

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

- **Panel** nodes (1-8) answer in parallel.
- An optional **Judge** compares them at temperature 0: consensus, contradictions, blind spots.
- One **Synthesizer** writes the final answer grounded in the judge's analysis.

OpenFusion follows the same high-level pattern as OpenRouter's Fusion: panel models first, an optional judge when you wire one, then a synthesizer.

Each node is a **source x model**. Pick the source from the chip on the node: **Vercel AI Gateway**, **OpenRouter**, **Claude Code**, or **Codex**. Then pick the model, a per-node thinking budget, and whether it gets web tools. Panel and judge nodes default to web tools on; synthesizer nodes default off. Click a source chip in the top bar to see its connection status and how to connect it.

Whatever graph is active is what every `/v1/chat/completions` request runs. Edit the graph and the next call uses the new wiring. Nothing to redeploy. OpenFusion ships with a default Vercel AI Gateway council (three panels, a judge, and a synthesizer). It runs once you add a Vercel AI Gateway key and your account has access to those model ids; otherwise change the node models on the canvas. Empty the graph and calls fail loudly (`Your OpenFusion graph isn't runnable yet.`) rather than guessing.

## Plug OpenFusion into your IDE or CLI

OpenFusion speaks the OpenAI API. Point any OpenAI-compatible client at:

```text
Base URL:  http://127.0.0.1:3000/v1
API key:   local-fusion     (any non-empty string; required only if you set FUSION_API_KEYS)
Model:     openfusion       (any name works; OpenFusion runs your active graph)
```

`/v1/models` lists `openfusion`, `fusion`, `openrouter/fusion`, and any valid `FUSION_MODEL_ALIASES` entries. Every listed id points at the same active graph. This helps clients that reject a model unless it appears in the model list.

If you set `FUSION_API_KEYS=key1,key2`, clients must send one of those keys (`Authorization: Bearer <key>` or the `x-fusion-api-key` header). Otherwise auth is open for local use.

### curl

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer local-fusion' \
  -H 'Content-Type: application/json' \
  -d '{"model":"openfusion","messages":[{"role":"user","content":"Compare Postgres vs SQLite for an offline-capable app."}]}'
```

Add `"stream": true` for OpenAI-compatible SSE (terminated by `[DONE]`).

If your client uses the newer Responses API, call the same base URL:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'Authorization: Bearer local-fusion' \
  -H 'Content-Type: application/json' \
  -d '{"model":"openfusion","instructions":"Be direct.","input":"Compare Postgres vs SQLite for an offline-capable app."}'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="local-fusion")
resp = client.chat.completions.create(
    model="openfusion",
    messages=[{"role": "user", "content": "Where would this plan fail?"}],
)
print(resp.choices[0].message.content)

response = client.responses.create(
    model="openfusion",
    instructions="Be direct.",
    input="Where would this plan fail?",
)
print(response.output_text)
```

### OpenAI Node SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:3000/v1", apiKey: "local-fusion" });
const resp = await client.chat.completions.create({
  model: "openfusion",
  messages: [{ role: "user", content: "Review this architecture." }],
});
console.log(resp.choices[0].message.content);

const response = await client.responses.create({
  model: "openfusion",
  instructions: "Be direct.",
  input: "Review this architecture.",
});
console.log(response.output_text);
```

### Cursor

Settings -> Models -> OpenAI API -> enable **Override OpenAI Base URL**:

```text
OpenAI Base URL:  http://127.0.0.1:3000/v1
OpenAI API Key:   local-fusion
Model:            openfusion
```

Any model name reaches OpenFusion intact and runs your graph, so Cursor's built-in model strings work too. If Cursor blocks an unknown model ID *before* the request leaves the app, map a Cursor-accepted label with `FUSION_MODEL_ALIASES=gpt-4o=openfusion`, restart OpenFusion so `/v1/models` advertises it, and select it.

### Continue.dev

In `~/.continue/config.json`:

```json
{
  "models": [
    { "title": "OpenFusion", "provider": "openai", "model": "openfusion",
      "apiBase": "http://127.0.0.1:3000/v1", "apiKey": "local-fusion" }
  ]
}
```

### aider

```bash
aider --openai-api-base http://127.0.0.1:3000/v1 \
      --openai-api-key local-fusion \
      --model openai/openfusion
```

### OpenCode

OpenFusion ships a checked-in `opencode.json` (port 3001):

```bash
npm run dev:opencode
OPENCODE_CONFIG=/path/to/fusion/opencode.json opencode
```

Run `/models` and choose the OpenFusion label. If the provider picker opens, press `esc`. Do not pick OpenAI/Anthropic/OpenRouter for this local setup.

Model discovery intentionally shows only the clean public aliases. Older preset aliases still resolve for existing configs, but they are hidden from `/v1/models`.

## Subscriptions

Codex and Claude Code subscriptions run as local council nodes through their official CLIs. They are not API keys for `/v1/chat/completions`; the runtime starts the signed-in local client in read-only print mode and normalizes the result.

The Codex and Claude Code integrations are local harness adapters with:

- official local client usage (read-only, print mode)
- scratch workspaces for isolated execution
- transcripts and provenance

**They connect automatically when local setup is present.** Install the CLI, sign in, and the matching source goes "Connected" once OpenFusion can find the CLI and see local auth or a provider credential env. No env flag to set. OpenFusion bypasses Codex user config and execpolicy rules during council runs, so a stale `~/.codex/config.toml` or project rules should not break the graph. The first model run still verifies that the upstream account can execute. The optional opt-out is `FUSION_CODEX_HARNESS=0` / `FUSION_CLAUDE_CODE_HARNESS=0`, which forces a harness off even when its CLI is present.

**CLI version drift is handled, not hidden.** OpenFusion probes the installed Claude CLI's `--help` once and adapts its flags to what that build supports. On an older build that lacks a hardening flag (for example `--tools`), the run still works and `/api/health` reports the reduced hardening as `cli_warnings` on the harness entry. Update the CLI to clear the warning, or point `FUSION_CLAUDE_CODE_COMMAND` at a newer build (it also accepts a wrapper script, useful for translating flags or pinning a specific install).

**Ambient billing vars never reach a harness.** OpenFusion strips `ANTHROPIC_*`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_AUTH_TOKEN`, `CODEX_API_KEY`, and the Bedrock/Vertex switches from harness child processes, so a gateway token exported in your shell cannot silently reroute a subscription-billed seat to per-token billing. Routing a harness through a gateway stays possible — but only explicitly, via `FUSION_*_ENV_JSON` (see below).

### Multiple Local Accounts

OpenFusion keeps harness account selection explicit:

- `FUSION_CODEX_HOME=/path/to/codex-home` sets `CODEX_HOME` for Codex runs. Use this when you want OpenFusion to use a different `codex login` than your normal terminal.
- `FUSION_CLAUDE_CODE_HOME=/path/to/claude-home` sets `HOME` for Claude Code runs. Use this when you want a separate Claude Code login/cache.
- `FUSION_CODEX_ENV_JSON` and `FUSION_CLAUDE_CODE_ENV_JSON` are optional JSON objects merged into only that harness process. Health checks and actual runs use the same resolver, so malformed env surfaces before a council run starts.

Example:

```bash
FUSION_CODEX_HOME=/path/to/codex-home
FUSION_CLAUDE_CODE_HOME=/path/to/claude-home
```

### Claude Code Through OpenRouter

Claude Code can also be pointed at an Anthropic-format gateway such as OpenRouter. That is useful when you want OpenRouter routing, budgets, or analytics for a Claude Code node. It is not the same as using your Claude Pro or Max subscription: once `ANTHROPIC_AUTH_TOKEN` is active, Claude Code uses that gateway credential for the run.

```bash
FUSION_CLAUDE_CODE_ENV_JSON={"ANTHROPIC_BASE_URL":"https://openrouter.ai/api","ANTHROPIC_AUTH_TOKEN":"<openrouter-key>","ANTHROPIC_API_KEY":""}
```

Notes:

- OpenRouter's Claude Code docs use `https://openrouter.ai/api`, not `/v1`.
- `ANTHROPIC_API_KEY` should be explicitly empty in the OpenRouter path so Claude Code does not prefer a direct Anthropic key.
- For normal Claude subscription usage, leave `FUSION_CLAUDE_CODE_ENV_JSON` empty and sign in with Claude Code.

## Call It From MCP Agents

OpenFusion doubles as an MCP server: the running engine serves a `deep_consensus` tool over Streamable HTTP at `/api/mcp`. Register it user-scope in Claude Code and the council is callable from every session:

```bash
claude mcp add --transport http --scope user openfusion http://127.0.0.1:3000/api/mcp
```

If `FUSION_API_KEYS` is set, add the key:

```bash
claude mcp add --transport http --scope user openfusion http://127.0.0.1:3000/api/mcp \
  --header "Authorization: Bearer <key>"
```

Council runs routinely take minutes, and some MCP clients default to short tool timeouts. For Claude Code, launch with `MCP_TOOL_TIMEOUT=600000` (ms) or set a per-server `"timeout"` in `.mcp.json`. Any other MCP client that speaks Streamable HTTP can register the same endpoint. See [API.md](API.md) for the tool contract.

## Spending Caps

Optional caps refuse to start new hosted (API-billed) runs once a UTC window's recorded spend reaches the limit:

```bash
FUSION_BUDGET_DAILY_USD=5
FUSION_BUDGET_MONTHLY_USD=50
```

Refusals are `402 budget_exceeded`. Claude Code and Codex plan-billed seats are exempt — a harness-only council always runs. The ledger lives at `<FUSION_DATA_DIR>/spend-ledger.jsonl`, and `/api/health` reports current spend, caps, and exceeded flags in its `budget` block. Full semantics in [API.md](API.md).

## Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `503 configuration_required` | Runtime provider credentials are missing | Set `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, or connect the source in the studio |
| `Your OpenFusion graph isn't runnable yet.` | The active graph has no panel, or not exactly one synthesizer | Open the studio: add >=1 panel node and exactly one synthesizer |
| `401 unauthorized` | Local auth is enabled and client key is missing or wrong | Send `Authorization: Bearer <key>` |
| `400 invalid_request_error` | Unsupported model, tool, or request shape | Check `/v1/models` and the API docs |
| Client says model not found, OpenFusion logs no request | Client rejected the model locally | Use `FUSION_MODEL_ALIASES` |
| OpenCode shows built-in models | OpenCode did not load `opencode.json` | Start with `OPENCODE_CONFIG=/path/to/fusion/opencode.json` |
| Codex or Claude Code says it is not signed in | OpenFusion could not find local CLI auth for the selected home | Run `codex login` or `claude auth login`, then recheck |
| Codex says an option is unsupported | The installed Codex CLI is older than the harness expects | Update Codex with your normal CLI update path, then recheck |
| `/api/health` shows `cli_warnings` on Claude Code | The installed Claude CLI lacks a flag OpenFusion normally passes; runs work with reduced hardening | Update Claude Code, or set `FUSION_CLAUDE_CODE_COMMAND` to a newer build |
| Claude Code routes to OpenRouter unexpectedly | A gateway token was set in `FUSION_CLAUDE_CODE_ENV_JSON` | Clear the `ANTHROPIC_*` entries from `FUSION_CLAUDE_CODE_ENV_JSON`; ambient shell tokens are already stripped |
| `402 budget_exceeded` | A configured spend cap refuses to start new hosted runs | Raise `FUSION_BUDGET_DAILY_USD` / `FUSION_BUDGET_MONTHLY_USD`, wait for the UTC window to roll, or run a harness-only council |
