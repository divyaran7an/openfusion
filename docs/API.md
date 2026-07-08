# API

OpenFusion exposes a local OpenAI-compatible API plus native run/trace endpoints for the single-page local studio.

If `FUSION_API_KEYS` is set, send either:

```text
Authorization: Bearer <key>
x-fusion-api-key: <key>
```

## OpenAI-Compatible API

Base URL:

```text
http://127.0.0.1:3000/v1
```

### `GET /v1/models`

Returns `openfusion` plus compatibility aliases that all point at your active graph. The `fusion` metadata extension reports the live panel size, panel/judge/synthesizer models, and tool settings of the council that is currently on the canvas.

```json
{
  "object": "list",
  "data": [
    {
      "id": "openfusion",
      "object": "model",
      "created": 1782453612,
      "owned_by": "fusion",
      "fusion": {
        "panel_size": 3,
        "panel_models": ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"],
        "outer_model": "anthropic/claude-opus-4.8"
      }
    },
    {
      "id": "openrouter/fusion",
      "object": "model",
      "created": 1782453612,
      "owned_by": "fusion",
      "fusion": {
        "panel_size": 3,
        "panel_models": ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"],
        "outer_model": "anthropic/claude-opus-4.8"
      }
    }
  ]
}
```

### `GET /v1/models/{model}`

Returns a model object for the slug your client asks about. This is intentionally
permissive: `openfusion`, `fusion`, `openrouter/fusion`, `cursor-default`, or a
client's hardcoded model string all resolve to the active graph metadata. Some
OpenAI-compatible clients preflight the selected model before their first chat
request, so this route avoids a false "model not found" failure.

The **model ID is a label, not a selector**. The active graph runs regardless of
what you send to `/v1/chat/completions`. `openfusion` is canonical, but any other
name works too, which is what makes OpenFusion a drop-in for clients that carry a
hardcoded model string.

### `POST /v1/chat/completions`

Basic request:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion",
    "messages": [
      { "role": "user", "content": "Review this architecture." }
    ]
  }'
```

The response is an OpenAI-style chat completion with a `fusion` metadata extension containing run ID, mode, trace ID, panel size, cost, latency, provider generation IDs, `cost_source`, and `cost_coverage` when available. The metadata key remains `fusion` for stored-record and client compatibility. `cost_source` is `provider_reported` when every expected provider call returned authoritative Vercel AI Gateway/OpenRouter/harness pricing, otherwise `estimate`.

Streaming uses OpenAI-compatible SSE chunks. Runtime progress chunks include a `fusion_event` extension; final chunks include `fusion` metadata; streams end with `[DONE]`.

`max_completion_tokens` follows the current OpenAI client expectation and caps the final assistant response. The older `max_tokens` field is still accepted for legacy clients. Panel and judge calls keep enough internal room for evidence and structured analysis, so a small client cap does not break the council before the synthesizer writes the visible answer. Fusion compatibility tool/plugin `max_completion_tokens` remains the most specific override.

### `POST /v1/responses`

Responses API compatibility is a bridge over the same active graph and the same execution path as Chat Completions. It exists for newer OpenAI SDK and agent clients that call the Responses endpoint.

Basic request:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openfusion",
    "instructions": "Be direct.",
    "input": "Review this architecture."
  }'
```

Supported request shape:

- `input` accepts a string, text message items, prior assistant message items, `function_call`, and `function_call_output` items.
- Text content parts with `type: "input_text"`, `type: "output_text"`, or `type: "text"` are normalized into the Chat Completions text path.
- `instructions` becomes a developer message for this request.
- `max_output_tokens` maps to `max_completion_tokens`.
- `text.format` accepts `text`, `json_object`, and `json_schema`; the same JSON validation used by Chat Completions applies.
- `tools` accepts Responses-style function tools (`{ "type": "function", "name": "read_file" }`) plus OpenRouter Fusion/web server tools. Function tools are returned as `function_call` output items. OpenFusion does not execute client tools server-side.
- `tool_choice` accepts `auto`, `none`, `required`, and named function choices (`{ "type": "function", "name": "read_file" }`).
- `previous_response_id` resolves a saved OpenFusion response id (`resp_<run>`) and prepends that prior user/assistant exchange as context. Unknown ids fail before model work.
- `stream: true` emits Responses-style SSE events such as `response.created`, `response.output_text.delta`, and `response.completed`, then `[DONE]`.

Unsupported request shape:

- Image, audio, and file input parts are rejected before model calls.
- Hosted OpenAI Responses tools such as `web_search_preview`, `file_search`, `computer`, and `code_interpreter` are not executed by this bridge. Configure web/search/fetch on the OpenFusion graph or use the OpenRouter server-tool forms documented below.
- Background mode, hosted conversations, and OpenAI-managed response retrieval are not implemented. OpenFusion persists its own native run and thread records under `/api/runs` and `/api/threads`.

### OpenAI Client Fields

OpenFusion accepts the common Chat Completions fields that agent clients send:

- `messages` accepts `system`, `developer`, `user`, `assistant`, and `tool` roles. Plain string content and OpenAI text content parts (`{ "type": "text", "text": "Summarize this" }`) are normalized into the text prompt. Image, audio, and file content parts are rejected before model calls because the council endpoint is text-only today.
- `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, and `stop` are applied to the final visible answer. Panel and judge nodes keep their graph-level model settings so a client slider does not accidentally change the council itself.
- `response_format` accepts `text`, `json_object`, and `json_schema`. For JSON formats, OpenFusion instructs the synthesizer, buffers streamed output until the final text is complete, and fails the request if the final answer does not match the requested JSON contract. `json_object` must be a JSON object. `json_schema` is compiled before any model call and validated again before the response is saved or returned.
- `stream_options.include_usage: true` emits a final OpenAI-style usage chunk with `choices: []` before `[DONE]`.
- `n` must be omitted or `1`. OpenFusion returns one council answer per request.
- `modalities` must be omitted or `["text"]`. Audio and image completions are not exposed through this endpoint yet.
- `parallel_tool_calls` and `user` are accepted for client compatibility. Client `type: "function"` tools are documented below.
- Deprecated `functions` and `function_call` are accepted and normalized to `tools` and `tool_choice`, so older OpenAI-compatible clients do not silently lose their function tools.

## Fusion Compatibility

OpenFusion accepts OpenRouter-style Fusion forms:

```json
{
  "model": "openrouter/fusion",
  "messages": [
    { "role": "user", "content": "Compare these architecture options." }
  ]
}
```

Plugin config:

```json
{
  "model": "openrouter/fusion",
  "plugins": [
    {
      "id": "fusion",
      "analysis_models": [
        "anthropic/claude-opus-4.8",
        "openai/gpt-5.5",
        "google/gemini-3.1-pro-preview"
      ],
      "model": "openai/gpt-5.5",
      "preset": "general-high",
      "enabled": true,
      "max_tool_calls": 8
    }
  ],
  "messages": [
    { "role": "user", "content": "Where would this plan fail?" }
  ]
}
```

Server-tool config:

```json
{
  "model": "fusion/fusion",
  "tools": [
    {
      "type": "fusion:fusion",
      "parameters": {
        "analysis_models": [
          "anthropic/claude-opus-4.8",
          "openai/gpt-5.5",
          "google/gemini-3.1-pro-preview"
        ],
        "model": "openai/gpt-5.5",
        "outer_model": "anthropic/claude-opus-4.8",
        "max_tool_calls": 8,
        "max_completion_tokens": 4096
      }
    }
  ],
  "tool_choice": "required",
  "messages": [
    { "role": "user", "content": "Audit this release plan." }
  ]
}
```

`openrouter:fusion` and `fusion:fusion` remain accepted compatibility tool names.

Behavior:

- `analysis_models` maps to the panel, capped at eight.
- `model` maps to the judge.
- `outer_model` is OpenFusion's final synthesis extension.
- `preset: "general-high"` maps to the strongest distinct model families (Opus, GPT, Gemini Pro).
- `preset: "general-budget"` maps to a cheaper panel (Gemini Flash, DeepSeek Pro, DeepSeek Flash) with the same frontier judge.
- `preset: "general-fast"` maps to a latency-homogeneous fast panel (Gemini Flash, DeepSeek Flash).
- Unknown preset slugs return `400 invalid_request_error` instead of silently running defaults.
- Explicit `analysis_models` or `model` always take precedence over a preset.
- `enabled: false` disables the Fusion tool for one `openrouter/fusion` request unless an explicit Fusion server tool is supplied.
- `tool_choice: "required"` forces Fusion only when Fusion is the only available tool.
- A specific `tool_choice` of `openrouter:fusion` or `fusion:fusion` forces Fusion.

OpenFusion follows the same high-level pattern as OpenRouter's Fusion: panel models first, an optional judge when configured, then a synthesizer.

## Web Tool Config

OpenRouter-style web tool entries are parsed as Fusion web-tool configuration:

```json
{
  "model": "openrouter/fusion",
  "tools": [
    {
      "type": "openrouter:web_search",
      "parameters": {
        "engine": "parallel",
        "max_results": 5,
        "allowed_domains": ["openrouter.ai"],
        "excluded_domains": ["reddit.com"]
      }
    },
    {
      "type": "openrouter:web_fetch",
      "parameters": {
        "engine": "parallel",
        "max_uses": 2,
        "allowed_domains": ["openrouter.ai"],
        "blocked_domains": ["localhost"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "Summarize the latest Fusion docs." }
  ]
}
```

For Vercel AI Gateway nodes, OpenFusion maps this config onto the available Vercel AI Gateway, Parallel, and local fetch tools. For OpenRouter nodes, it forwards the supported config as OpenRouter server-side `web_search` and `web_fetch` tools.

## Client Function Tools

OpenAI `type: "function"` tools are passed to the outer model and returned as OpenAI-compatible `tool_calls`. OpenFusion does not execute client tools server-side.

Hosted synthesizer nodes use the provider's native tool-calling path. Claude Code and Codex synthesizer nodes use a structured JSON bridge because the local CLI adapters run in one-shot print mode, not as native OpenAI tool-call transports. If the client forces a tool call and the harness does not return the expected tool-call JSON, OpenFusion returns a clear runtime error instead of silently dropping the tool.

If the client sends follow-up `tool` messages, OpenFusion preserves them as continuation context and treats tool results as untrusted evidence.

## Native API

The native endpoints power the local studio:

- `GET /api/health`
- `GET /api/graph` and `PUT /api/graph`: read and write the active council graph (powers the studio)
- `GET /api/threads`
- `GET /api/threads/:id`
- `GET /api/runs`
- `POST /api/runs`
- `POST /api/runs/stream`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events`

`POST /api/runs` and `POST /api/runs/stream` run the **active graph**, exactly like `/v1/*`: send `{ "prompt": "..." }` (or `messages`) and the council currently on the canvas executes. A request-level `fusion` override with `panel_models` still wins where provided, and an unrunnable graph fails loudly with `503 configuration_required` instead of falling back to models you never chose.

`POST /api/runs/stream` streams native runtime events:

- `run.started`
- `panel.started`
- `panel.finished`
- `panel.failed`
- `tool.started`
- `tool.finished`
- `tool.failed`
- `judge.started`
- `judge.finished`
- `judge.failed`
- `synthesis.started`
- `synthesis.finished`
- `synthesis.failed`
- `run.completed`

Saved event traces can be replayed as JSON or SSE:

```bash
curl http://127.0.0.1:3000/api/runs/run_xxx/events
curl -N "http://127.0.0.1:3000/api/runs/run_xxx/events?stream=1"
```

The in-flight event bus is process-local. Persisted traces survive when Redis is configured, but active subscribers are not coordinated across multiple Node processes yet.

## MCP Server

OpenFusion is also an MCP server. The engine serves a stateless Streamable HTTP endpoint at:

```text
http://127.0.0.1:3000/api/mcp
```

It exposes one tool, **`deep_consensus`**, which runs the active graph — the same council, merge semantics, auth, and budget guard as every other entry point:

```json
{
  "name": "deep_consensus",
  "input": {
    "question": "required string — the question or task for the council",
    "system_prompt": "optional string — system framing for the run",
    "thread_id": "optional string — continue a prior council conversation"
  }
}
```

The tool returns the synthesized answer as text content plus structured metadata (`run_id`, `thread_id`, `turn_index`, `status`, `degraded`, `panel_size`, `panel_models`, `judge_model`, `outer_model`, `cost_usd`, `cost_source`, `latency_ms_end_to_end`). Full run detail stays behind `GET /api/runs/:id`. Failures — unrunnable graph, budget refusal, all panels failed — come back as in-band tool errors with the reason.

**Follow-ups work.** Every call belongs to a thread: the first call mints a `thread_id` and returns it; pass it back on the next call and the council sees the thread's earlier questions and answers as conversation context (the last 12 turns). Threads are the same objects the studio and `GET /api/threads` show.

**The structured output is an additive-only contract.** Fields may be added over time; existing fields are never renamed, removed, or repurposed, so agents built against an older shape keep working. The server's `serverInfo.version` tracks the OpenFusion package version.

Register it in Claude Code (user scope makes the council callable from every session):

```bash
claude mcp add --transport http --scope user openfusion http://127.0.0.1:3000/api/mcp
```

If `FUSION_API_KEYS` is set, add `--header "Authorization: Bearer <key>"`.

Council runs routinely take minutes. Clients with short MCP tool timeouts should raise them — for Claude Code, launch with `MCP_TOOL_TIMEOUT=600000` (ms) or set a per-server `"timeout"` in `.mcp.json`. When the client sends a progress token, OpenFusion forwards fusion run events as MCP progress notifications to keep the stream alive.

## Budget Guard

Optional hosted-spend caps, configured by env:

```bash
FUSION_BUDGET_DAILY_USD=5
FUSION_BUDGET_MONTHLY_USD=50
```

Semantics are deliberately honest:

- Every completed run's hosted (API-billed) spend is appended to `<FUSION_DATA_DIR>/spend-ledger.jsonl` — durable across restarts with no external services. Provider-reported costs are used when coverage is complete; otherwise the run's token estimate is recorded (and counts toward the cap, conservatively).
- Once a UTC calendar window's recorded spend reaches a cap, new hosted runs are **refused before they start** with `402 budget_exceeded`, on `/v1/*`, the native run paths, and the MCP tool alike. A run admitted just under the cap can still overshoot it — the guard bounds when spending stops, not the final cent.
- Claude Code and Codex plan-billed seats are exempt by model classification: they contribute nothing to the cap, and a harness-only council is never refused.

Current spend, caps, and exceeded flags are reported in `GET /api/health` as the `budget` block.

## Errors

- `401 unauthorized`: local API auth is enabled and the key is missing or invalid.
- `400 invalid_request_error`: malformed request, unsupported model/tool, or invalid Fusion config.
- `402 budget_exceeded`: a configured spend cap refuses to start a new hosted run.
- `503 configuration_required`: provider credentials are missing, or the active graph is not runnable.
