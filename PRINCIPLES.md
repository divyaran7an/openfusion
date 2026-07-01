# Principles

What OpenFusion stands for. These are the rules we hold the project to. If a change violates one, it needs a very good reason.

### 1. Local orchestration

The studio, graph, logs, and OpenAI-compatible endpoint run on your machine. Model work runs through the sources you choose: Gateway, Claude Code, Codex, or another provider you wire in. Prompts and tool context can leave your machine when a node calls one of those sources. There is no OpenFusion cloud, account, or telemetry.

### 2. Open and hackable

MIT licensed, no closed core, no "pro" tier gating the good parts. The whole graph engine, the studio, and the OpenAI endpoint are in this repo. Fork it, rewire it, embed it.

### 3. You compose it, no magic

There are no fixed modes or presets you can't open up. The canvas *is* the configuration: every node is a `source x model` you chose, and the endpoint runs exactly that graph. Presets are starting points, not black boxes. Change any node and the next call uses it.

### 4. Inspired by the source, honest about the source

The panel, judge, synthesizer pattern is [OpenRouter's Fusion](https://openrouter.ai/docs/guides/features/server-tools/fusion). We didn't invent it; we made the high-level pipeline inspectable, configurable, and runnable through your own sources. In OpenFusion the judge is optional, but when present it **compares** instead of voting or averaging. The synthesizer writes from the judge analysis or raw panel responses instead of concatenating, and we credit OpenRouter plainly.

### 5. Bring your own

Use what you already pay for. Claude Code and Codex subscriptions can become real reasoning nodes through their official local CLIs; one Gateway key adds broad hosted-model access. Provider limits and credit rules still apply. No token scraping, no browser automation, no re-buying access you already have through a separate OpenFusion cloud.

### 6. Show your work

Compound systems are opaque by default; we refuse that. When the council runs you see each model's status, output, tool calls, tokens, and cost estimate when available. Errors say what actually failed and on which node. No spinner that hides which upstream call is spending money.

### 7. No surprises with money or trust

**Stop** cancels the upstream calls. Hitting it stops the spend, it doesn't just hide the stream. There are no silent fallbacks to a different model, no hidden retries that multiply cost, no secrets committed to the repo. What you wired is what runs.

### 8. A real drop-in

OpenFusion speaks the OpenAI Chat Completions API: streaming, tool calls, errors, the lot. It works with the editors and CLIs you already use. Point Cursor, aider, Continue, or the OpenAI SDK at one base URL and the council answers. Compatibility is a feature, not an afterthought.

---

These principles are why OpenFusion exists: the compound-AI idea is powerful, and it should be something you can **compose yourself, see fully, and own**, not only a service you rent.
