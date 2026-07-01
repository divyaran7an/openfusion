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

Returns a single model, `fusion`, describing your active graph. The `fusion`
metadata extension reports the live panel size, panel/judge/synthesizer models,
and tool settings of the council that is currently on the canvas.

```json
{
  "object": "list",
  "data": [
    {
      "id": "fusion",
      "object": "model",
      "created": 1782453612,
      "owned_by": "fusion",
      "fusion": { "panel_size": 3, "panel_models": ["…"], "outer_model": "…" }
    }
  ]
}
```

The **model ID is a label, not a selector**. The active graph runs regardless of
what you send. `fusion` is canonical; any other name works too (`gpt-4o`,
`openrouter/fusion`, `fusion-3`, …), which is what makes OpenFusion a drop-in for
clients that carry a hardcoded model string.

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

The response is an OpenAI-style chat completion with a `fusion` metadata extension containing run ID, mode, trace ID, panel size, cost, latency, provider generation IDs, `cost_source`, and `cost_coverage` when available. The metadata key remains `fusion` for stored-record and client compatibility.

Streaming uses OpenAI-compatible SSE chunks. Runtime progress chunks include a `fusion_event` extension; final chunks include `fusion` metadata; streams end with `[DONE]`.

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
        "google/gemini-3-pro-preview"
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
          "google/gemini-3-pro-preview"
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
- `preset: "general-high"` maps to the full-fusion template.
- `preset: "general-budget"` maps to the small-fusion template.
- `enabled: false` disables the Fusion tool for one `openrouter/fusion` request unless an explicit Fusion server tool is supplied.
- `tool_choice: "required"` forces Fusion only when Fusion is the only available tool.
- A specific `tool_choice` of `openrouter:fusion` or `fusion:fusion` forces Fusion.

OpenFusion's panel → judge → synthesizer pipeline is faithful to (and inspired by) OpenRouter's Fusion.

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

## Client Function Tools

OpenAI `type: "function"` tools are passed to the outer model and returned as OpenAI-compatible `tool_calls`. OpenFusion does not execute client tools server-side.

If the client sends follow-up `tool` messages, OpenFusion preserves them as continuation context and treats tool results as untrusted evidence.

## Native API

The native endpoints power the local studio:

- `GET /api/health`
- `GET /api/graph` · `PUT /api/graph`: read and write the active council graph (powers the studio)
- `GET /api/threads`
- `GET /api/threads/:id`
- `GET /api/runs`
- `POST /api/runs`
- `POST /api/runs/stream`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events`

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

## Errors

- `401 unauthorized`: local API auth is enabled and the key is missing or invalid.
- `400 invalid_request_error`: malformed request, unsupported model/tool, or invalid Fusion config.
- `503 configuration_required`: provider credentials are missing.
