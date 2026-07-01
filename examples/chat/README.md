# OpenFusion chat example

A minimal chat client for your OpenFusion server, plus copy-paste configs to point
any OpenAI-compatible CLI or IDE at it.

OpenFusion speaks the **OpenAI Chat Completions API**. Anything that talks to OpenAI
talks to OpenFusion. You only change the **base URL** to `http://localhost:3000/v1`
and the **model** to `openfusion` (any model name works; it runs your active council).

First, start the server from the project root:

```bash
npm run dev
```

## Terminal chat (zero dependencies)

```bash
node examples/chat/chat.mjs
```

Streams the answer token-by-token and shows the live council phases
(`panel deliberating…` → `judge comparing…` → `synthesizing…`). Configure with:

```bash
FUSION_BASE_URL=http://localhost:3000/v1 FUSION_MODEL=openfusion node examples/chat/chat.mjs
```

## Browser chat

Open `examples/chat/index.html` in a browser (or serve the folder with
`npx serve examples/chat`). Set the base URL / model in the header and chat. The
`/v1` endpoints send CORS headers, so the page can call your local server directly.

> The `/v1` endpoints allow cross-origin requests (`Access-Control-Allow-Origin: *`),
> like other local OpenAI servers. If you don't set `FUSION_API_KEYS`, any web page
> you visit can reach your local server (and your Gateway spend). Set a key to gate it.

## Plug OpenFusion into your tools

Every client below just needs the base URL and a model name. Use any key. It's
only enforced if you set `FUSION_API_KEYS` on the server.

### OpenAI SDK, Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="local-fusion")
stream = client.chat.completions.create(
    model="openfusion",
    messages=[{"role": "user", "content": "Compare Postgres and SQLite for a desktop app."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### OpenAI SDK, Node

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "local-fusion" });
const stream = await client.chat.completions.create({
  model: "openfusion",
  messages: [{ role: "user", content: "Where would this plan fail?" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

### curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer local-fusion" \
  -d '{"model":"openfusion","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

### Cursor

Settings → Models → **Override OpenAI Base URL** = `http://localhost:3000/v1`, set
the API key to `local-fusion`, and add a custom model named `openfusion`.

### Continue (`~/.continue/config.json`)

```json
{
  "models": [
    {
      "title": "OpenFusion",
      "provider": "openai",
      "model": "openfusion",
      "apiBase": "http://localhost:3000/v1",
      "apiKey": "local-fusion"
    }
  ]
}
```

### aider

```bash
export OPENAI_API_BASE=http://localhost:3000/v1
export OPENAI_API_KEY=local-fusion
aider --model openai/openfusion
```

### OpenCode (`opencode.json`)

```json
{
  "provider": {
    "openfusion": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "local-fusion" },
      "models": { "openfusion": { "name": "OpenFusion" } }
    }
  }
}
```

That's the whole point of OpenFusion: one endpoint, every tool, a full council
behind a single model name.
